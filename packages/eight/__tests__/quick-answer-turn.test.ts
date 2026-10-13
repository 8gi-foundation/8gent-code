/**
 * #3411: the quick-answer lane, end to end through a real Agent turn on the local
 * text-tool path, with the model stubbed (fixtures/quick-answer-probe.ts).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../../tests/temp-dirs";
import { QUICK_LABEL, QUICK_TOOLS } from "../quick-answer";

afterAll(cleanupTempDirs);

type Probe = {
	reply: string;
	seen: Array<{
		quick: boolean;
		tools: string[];
		model: string;
		reasoningEffort: string | null;
		chars: number;
		system: string;
		roles: string[];
	}>;
	runs: Array<{
		quick?: {
			class: string;
			ran: boolean;
			ok: boolean;
			reason?: string;
			tools: number;
			model?: string;
			modelSource?: string;
			promptTokens?: number[];
		};
	}>;
	executed: string[];
};

function probe(
	mode: "answer" | "needs-deep" | "long-error",
	prompt: string,
	flag: string | undefined,
	extra: Record<string, string> = {},
): Probe {
	const root = tempDir("quick-answer-");
	mkdirSync(join(root, "home"));
	mkdirSync(join(root, "work"));
	const {
		EIGHT_QUICK_ANSWER: _flag,
		EIGHT_QUICK_MODEL: _model,
		PROBE_TAGS: _tags,
		...base
	} = process.env;
	const env = {
		...base,
		HOME: join(root, "home"),
		...(flag === undefined ? {} : { EIGHT_QUICK_ANSWER: flag }),
		...extra,
	};
	const r = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "fixtures", "quick-answer-probe.ts"),
			mode,
			join(root, "work"),
			prompt,
		],
		{ env, stdout: "pipe", stderr: "pipe" },
	);
	const line = r.stdout
		.toString()
		.split("\n")
		.find((l) => l.startsWith("@@PROBE@@"));
	if (!line)
		throw new Error(
			`probe printed no result (exit ${r.exitCode}): ${r.stderr.toString().slice(-800)}`,
		);
	return JSON.parse(line.slice("@@PROBE@@".length));
}

const QUESTION = "which port does the server listen on?";
// The conv-quick-answer pilot prompt, verbatim from ~/.8gent/rishi-pilot/scenarios.json.
const PILOT_PROMPT =
	"Quick question, no need to change anything: if I start this server with APP_MODE=staging and no PORT set, which port does it listen on? And which one when APP_MODE isn't set at all? Just tell me in a sentence or two, then end your reply with exactly one line in this form: ANSWER: staging=<port> unset=<port>";
/** Chars the endpoint must process for the lane's first request (round 4: ~400 tok/s on the 9B). */
const LANE_FIRST_REQUEST_BUDGET = 4000;

describe("quick-answer lane in a real turn (#3411)", () => {
	test("flag on, quick prompt: labelled answer, read-only tools only, no full loop", () => {
		const p = probe("answer", QUESTION, "1");
		expect(p.reply.startsWith(QUICK_LABEL)).toBe(true);
		expect(p.reply).toContain("4100");
		const quick = p.seen.filter((s) => s.quick);
		expect(quick.length).toBeGreaterThan(0);
		// No request outside the lane except the capability probe (a single "noop" tool).
		expect(p.seen.every((s) => s.quick || s.tools.length <= 1)).toBe(true);
		for (const s of quick) for (const t of s.tools) expect(QUICK_TOOLS.has(t)).toBe(true);
		expect(quick[0].tools).toContain("read_file");
		expect(quick[0].tools).not.toContain("write_file");
		expect(p.runs.at(-1)?.quick).toMatchObject({ class: "quick", ran: true, ok: true, tools: 1 });
	}, 60_000);

	test("flag on, model says NEEDS_DEEP: the full loop answers, unlabelled", () => {
		const p = probe("needs-deep", QUESTION, "1");
		expect(p.reply).toContain("full loop answer");
		expect(p.reply).not.toContain(QUICK_LABEL);
		expect(p.seen.some((s) => s.quick)).toBe(true);
		expect(p.seen.some((s) => !s.quick && s.tools.includes("write_file"))).toBe(true);
		expect(p.runs.at(-1)?.quick).toMatchObject({
			class: "quick",
			ran: true,
			ok: false,
			reason: "model asked for the full loop",
		});
	}, 60_000);

	test("flag on, an instruction: the lane never runs", () => {
		const p = probe("answer", "fix the port in server.ts", "1");
		expect(p.seen.some((s) => s.quick)).toBe(false);
		expect(p.runs.at(-1)?.quick).toMatchObject({ class: "deep", ran: false });
		expect(p.reply).not.toContain(QUICK_LABEL);
	}, 60_000);

	test("flag off (default): the lane never runs", () => {
		const p = probe("answer", QUESTION, undefined);
		expect(p.seen.some((s) => s.quick)).toBe(false);
		expect(p.runs.at(-1)?.quick).toBeUndefined();
		expect(p.reply).toContain("full loop answer");
	}, 60_000);

	test("flag on, a quoted quick prompt: no run_command runs, the pre-tool router stays off (8SO F1)", () => {
		const p = probe("answer", 'where is "apiKey" set?', "1");
		expect(p.runs.at(-1)?.quick?.class).toBe("quick");
		expect(p.executed).not.toContain("run_command");
		for (const name of p.executed) expect(QUICK_TOOLS.has(name)).toBe(true);
	}, 60_000);

	test("EIGHT_QUICK_MODEL unset: the lane runs on qwen3.5:9b when installed, and logs the pick", () => {
		const p = probe("answer", QUESTION, "1", { PROBE_TAGS: "probe:1b,qwen3.5:9b" });
		const quick = p.seen.filter((s) => s.quick);
		expect(quick.length).toBeGreaterThan(0);
		for (const s of quick) expect(s.model).toBe("qwen3.5:9b");
		expect(p.runs.at(-1)?.quick).toMatchObject({ model: "qwen3.5:9b", modelSource: "preferred" });
	}, 60_000);

	test("EIGHT_QUICK_MODEL set: it wins over the preferred model", () => {
		const p = probe("answer", QUESTION, "1", {
			PROBE_TAGS: "probe:1b,qwen3.5:9b",
			EIGHT_QUICK_MODEL: "probe:1b",
		});
		for (const s of p.seen.filter((x) => x.quick)) expect(s.model).toBe("probe:1b");
		expect(p.runs.at(-1)?.quick).toMatchObject({ model: "probe:1b", modelSource: "env" });
	}, 60_000);

	test("nothing preferred installed: the lane uses the session model", () => {
		const p = probe("answer", QUESTION, "1");
		for (const s of p.seen.filter((x) => x.quick)) expect(s.model).toBe("probe:1b");
		expect(p.runs.at(-1)?.quick).toMatchObject({ model: "probe:1b", modelSource: "session" });
	}, 60_000);

	test("lane requests turn thinking off; full-loop requests do not", () => {
		const p = probe("needs-deep", QUESTION, "1");
		const quick = p.seen.filter((s) => s.quick);
		const full = p.seen.filter((s) => !s.quick && s.tools.includes("write_file"));
		expect(quick.length).toBeGreaterThan(0);
		expect(full.length).toBeGreaterThan(0);
		for (const s of quick) expect(s.reasoningEffort).toBe("none");
		for (const s of full) expect(s.reasoningEffort).toBeNull();
	}, 60_000);

	test("a long lane failure reason is capped at 200 chars in the run log (8SO Q-R1)", () => {
		const p = probe("long-error", QUESTION, "1");
		const q = p.runs.at(-1)?.quick;
		expect(q).toMatchObject({ class: "quick", ran: true, ok: false });
		expect((q?.reason ?? "").length).toBeGreaterThan(0);
		expect((q?.reason ?? "").length).toBeLessThanOrEqual(200);
		expect(p.reply).toContain("full loop answer");
	}, 60_000);

	test("the lane's first request for the pilot prompt stays under the char budget, with no agent prompt or history", () => {
		const p = probe("answer", PILOT_PROMPT, "1");
		const quick = p.seen.filter((s) => s.quick);
		expect(quick.length).toBeGreaterThan(0);
		expect(quick[0].chars).toBeLessThan(LANE_FIRST_REQUEST_BUDGET);
		expect(quick[0].roles).toEqual(["system", "user"]);
		expect(quick[0].system).toContain("You are 8gent, answering a quick question");
		const full = p.seen.find((s) => !s.quick && s.tools.includes("write_file"));
		if (full) expect(full.system).not.toBe(quick[0].system);
	}, 60_000);

	test("prompt tokens per lane round go in the run log", () => {
		const p = probe("answer", QUESTION, "1");
		const q = p.runs.at(-1)?.quick;
		const rounds = p.seen.filter((s) => s.quick).length;
		expect(q?.promptTokens).toHaveLength(rounds);
		for (const t of q?.promptTokens ?? []) expect(t).toBeGreaterThan(0);
	}, 60_000);
});
