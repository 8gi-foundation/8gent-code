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
	seen: Array<{ quick: boolean; tools: string[]; model: string; reasoningEffort: string | null }>;
	runs: Array<{
		quick?: {
			class: string;
			ran: boolean;
			ok: boolean;
			reason?: string;
			tools: number;
			model?: string;
			modelSource?: string;
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
});
