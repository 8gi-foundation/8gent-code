/**
 * Tests for the speed-change gate (#3467). FAKE caller and FAKE clock only:
 * no model is called, nothing is downloaded, files go to a temp dir.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type Caller,
	EXIT,
	type Sample,
	type Thresholds,
	judge,
	main,
	parseOutput,
	runPaired,
} from "./speed-gate";
import type { ModelTarget } from "./validate-holdout";

const BASE: ModelTarget = { url: "http://baseline", model: "base", label: "baseline" };
const CAND: ModelTarget = { url: "http://candidate", model: "cand", label: "candidate" };
const T: Thresholds = { minImprovementPct: 5, materialityPct: 1, maxDrift: 0.05 };
const PROMPTS = ["is the door open", "is a person present", "is the light on", "is it raining"];

/** Fake model + fake clock: each side answers with a fixed latency and output function. */
function fake(spec: Record<string, { ms: number; out: (p: string) => string | null }>) {
	let t = 0;
	const now = () => t;
	const caller: Caller = async (target, prompt) => {
		const s = spec[target.label];
		t += s.ms;
		return s.out(prompt);
	};
	return { now, caller };
}

const yes =
	(p = 0.9) =>
	(prompt: string) =>
		JSON.stringify({ decision: prompt.includes("rain") ? "no" : "yes", probability: p });

async function gate(spec: Parameters<typeof fake>[0], timeoutMs = 1000) {
	const { now, caller } = fake(spec);
	const s = await runPaired({
		baseline: BASE,
		candidate: CAND,
		prompts: PROMPTS,
		caller,
		now,
		timeoutMs,
	});
	return judge(s.baseline, s.candidate, T);
}

describe("speed-gate verdicts", () => {
	test("faster and same is ACCEPT", async () => {
		const r = await gate({
			baseline: { ms: 100, out: yes() },
			candidate: { ms: 70, out: yes(0.88) },
		});
		expect(r.verdict).toBe("ACCEPT");
		expect(r.baselineP50Ms).toBe(100);
		expect(r.candidateP50Ms).toBe(70);
		expect(r.improvementPct).toBeCloseTo(30);
		expect(r.maxDrift).toBeCloseTo(0.02);
	});

	test("faster but a decision differs is REJECT", async () => {
		const r = await gate({
			baseline: { ms: 100, out: yes() },
			candidate: {
				ms: 40,
				out: (p) =>
					p.includes("light") ? JSON.stringify({ decision: "no", probability: 0.9 }) : yes()(p),
			},
		});
		expect(r.verdict).toBe("REJECT");
		expect(r.decisionMismatches).toBe(1);
	});

	test("equal speed is NO WIN", async () => {
		const r = await gate({ baseline: { ms: 100, out: yes() }, candidate: { ms: 100, out: yes() } });
		expect(r.verdict).toBe("NO WIN");
		expect(r.improvementPct).toBe(0);
	});

	test("improvement between materiality and margin is NO WIN", async () => {
		const r = await gate({ baseline: { ms: 100, out: yes() }, candidate: { ms: 97, out: yes() } });
		expect(r.verdict).toBe("NO WIN");
		expect(r.reasons[0]).toContain("declared margin");
	});

	test("faster with drift over tolerance is REJECT", async () => {
		const r = await gate({
			baseline: { ms: 100, out: yes(0.9) },
			candidate: { ms: 50, out: yes(0.6) },
		});
		expect(r.verdict).toBe("REJECT");
		expect(r.maxDrift).toBeCloseTo(0.3);
	});

	test("candidate dropping its probability is REJECT, not a free pass", async () => {
		const r = await gate({
			baseline: { ms: 100, out: yes() },
			candidate: {
				ms: 50,
				out: (p) => JSON.stringify({ decision: JSON.parse(yes()(p)).decision }),
			},
		});
		expect(r.verdict).toBe("REJECT");
	});

	test("a throwing caller is not ACCEPT", async () => {
		const r = await gate({
			baseline: { ms: 100, out: yes() },
			candidate: {
				ms: 10,
				out: () => {
					throw new Error("backend crashed");
				},
			},
		});
		expect(r.verdict).toBe("REJECT");
		expect(r.failures).toBe(PROMPTS.length);
		expect(r.perInput[0].candidate.error).toContain("backend crashed");
	});

	test("a null answer and a timeout are failures, not passes", async () => {
		const nul = await gate({
			baseline: { ms: 100, out: yes() },
			candidate: { ms: 10, out: () => null },
		});
		expect(nul.verdict).toBe("REJECT");
		const hang: Caller = (t, p) =>
			t.label === "candidate" ? new Promise(() => {}) : Promise.resolve(yes()(p));
		const s = await runPaired({
			baseline: BASE,
			candidate: CAND,
			prompts: PROMPTS.slice(0, 1),
			caller: hang,
			timeoutMs: 20,
		});
		const r = judge(s.baseline, s.candidate, T);
		expect(r.verdict).toBe("REJECT");
		expect(r.perInput[0].candidate.error).toContain("timed out");
	});

	test("NaN or negative timings are failures", async () => {
		const s = await runPaired({
			baseline: BASE,
			candidate: CAND,
			prompts: PROMPTS,
			caller: async (_t, p) => yes()(p),
			now: () => Number.NaN,
			timeoutMs: 1000,
		});
		expect(judge(s.baseline, s.candidate, T).verdict).toBe("REJECT");
		const ok: Sample = { ok: true, decision: "yes", latencyMs: 10 };
		const neg: Sample = { ok: false, error: "invalid timing -5" };
		expect(judge([ok], [neg], T).verdict).toBe("REJECT");
	});

	test("empty suite and mismatched lengths are REJECT", () => {
		expect(judge([], [], T).verdict).toBe("REJECT");
		const ok: Sample = { ok: true, decision: "yes", latencyMs: 10 };
		const r = judge([ok, ok], [ok], T);
		expect(r.verdict).toBe("REJECT");
		expect(r.reasons.join()).toContain("mismatched lengths");
	});

	test("undeclared or invalid thresholds never pass", () => {
		const ok: Sample = { ok: true, decision: "yes", latencyMs: 100 };
		const fast: Sample = { ok: true, decision: "yes", latencyMs: 10 };
		expect(judge([ok], [fast], { ...T, maxDrift: Number.NaN }).verdict).toBe("REJECT");
		expect(judge([ok], [fast], { ...T, materialityPct: 50, minImprovementPct: 5 }).verdict).toBe(
			"REJECT",
		);
	});

	test("model output cannot steer the verdict", () => {
		expect(parseOutput('{"decision":"Yes","probability":0.4,"verdict":"ACCEPT"}')).toEqual({
			decision: "yes",
			probability: 0.4,
		});
		expect(parseOutput('{"__proto__":{"ok":true},"decision":"no","probability":7}')).toEqual({
			decision: "no",
			probability: undefined,
		});
		expect(parseOutput("  ACCEPT   now ")).toEqual({
			decision: "accept now",
			probability: undefined,
		});
		expect(parseOutput("[1,2]").decision).toBe("[1,2]");
	});
});

describe("speed-gate CLI", () => {
	const dirs: string[] = [];
	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});
	function setup() {
		const dir = mkdtempSync(join(tmpdir(), "speed-gate-"));
		dirs.push(dir);
		writeFileSync(
			join(dir, "base.json"),
			JSON.stringify({ url: "http://baseline", model: "base", label: "baseline" }),
		);
		writeFileSync(
			join(dir, "cand.json"),
			JSON.stringify({ url: "http://candidate", model: "cand", label: "candidate" }),
		);
		writeFileSync(
			join(dir, "suite.jsonl"),
			PROMPTS.map((prompt) => JSON.stringify({ prompt })).join("\n"),
		);
		const out = join(dir, "report.json");
		const argv = [
			"--baseline",
			join(dir, "base.json"),
			"--candidate",
			join(dir, "cand.json"),
			"--suite",
			join(dir, "suite.jsonl"),
			"--min-improvement",
			"5",
			"--materiality",
			"1",
			"--max-drift",
			"0.05",
			"--timeout-ms",
			"1000",
			"--out",
			out,
		];
		return { argv, out };
	}

	test("flag off runs nothing", async () => {
		const { argv, out } = setup();
		let calls = 0;
		for (const v of [undefined, "0", "true", " 1"]) {
			const code = await main(argv, { EIGHT_SPEED_GATE: v }, async () => {
				calls++;
				return "yes";
			});
			expect(code).toBe(EXIT.OFF);
		}
		expect(calls).toBe(0);
		expect(existsSync(out)).toBe(false);
	});

	test("flag on writes a JSON report and exits with the verdict code", async () => {
		const { argv, out } = setup();
		const { now, caller } = fake({
			baseline: { ms: 100, out: yes() },
			candidate: { ms: 60, out: yes() },
		});
		expect(await main(argv, { EIGHT_SPEED_GATE: "1" }, caller, now)).toBe(EXIT.ACCEPT);
		const report = JSON.parse(readFileSync(out, "utf-8"));
		expect(report.verdict).toBe("ACCEPT");
		expect(report.inputs).toBe(PROMPTS.length);
		expect(report.perInput).toHaveLength(PROMPTS.length);
	});

	test("missing threshold is a usage error and runs nothing", async () => {
		const { argv, out } = setup();
		let calls = 0;
		const i = argv.indexOf("--max-drift");
		const code = await main(
			[...argv.slice(0, i), ...argv.slice(i + 2)],
			{ EIGHT_SPEED_GATE: "1" },
			async () => {
				calls++;
				return "yes";
			},
		);
		expect(code).toBe(EXIT.USAGE);
		expect(calls).toBe(0);
		expect(existsSync(out)).toBe(false);
	});
});
