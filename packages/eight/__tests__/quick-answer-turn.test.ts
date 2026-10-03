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

type Probe = { reply: string; seen: Array<{ quick: boolean; tools: string[] }> };

function probe(mode: "answer" | "needs-deep", prompt: string, flag: string | undefined): Probe {
	const root = tempDir("quick-answer-");
	mkdirSync(join(root, "home"));
	mkdirSync(join(root, "work"));
	const { EIGHT_QUICK_ANSWER: _inherited, ...base } = process.env;
	const env = {
		...base,
		HOME: join(root, "home"),
		...(flag === undefined ? {} : { EIGHT_QUICK_ANSWER: flag }),
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
	}, 60_000);

	test("flag on, model says NEEDS_DEEP: the full loop answers, unlabelled", () => {
		const p = probe("needs-deep", QUESTION, "1");
		expect(p.reply).toContain("full loop answer");
		expect(p.reply).not.toContain(QUICK_LABEL);
		expect(p.seen.some((s) => s.quick)).toBe(true);
		expect(p.seen.some((s) => !s.quick && s.tools.includes("write_file"))).toBe(true);
	}, 60_000);

	test("flag on, an instruction: the lane never runs", () => {
		const p = probe("answer", "fix the port in server.ts", "1");
		expect(p.seen.some((s) => s.quick)).toBe(false);
		expect(p.reply).not.toContain(QUICK_LABEL);
	}, 60_000);

	test("flag off (default): the lane never runs", () => {
		const p = probe("answer", QUESTION, undefined);
		expect(p.seen.some((s) => s.quick)).toBe(false);
		expect(p.reply).toContain("full loop answer");
	}, 60_000);
});
