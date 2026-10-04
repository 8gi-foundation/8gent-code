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
	GATE_SYSTEM_PROMPT,
	type Sample,
	type Thresholds,
	gateCaller,
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
		expect(r.maxDriftUnmeasurable).toBe(true);
		expect(r.maxDrift).toBeNull();
		const json = JSON.parse(JSON.stringify(r));
		expect(json.perInput[0].driftUnmeasurable).toBe(true);
	});

	test("the same deterministic model on both sides, through the real parse path, is NO WIN", async () => {
		// Real-looking replies: fenced JSON, stray whitespace, a plain "Yes." on one prompt.
		const model = (p: string) =>
			p.includes("light")
				? "Yes.\n"
				: `\`\`\`json\n{"decision": "${p.includes("rain") ? "No" : "Yes"}", "probability": 0.81}\n\`\`\`  `;
		const r = await gate({ baseline: { ms: 100, out: model }, candidate: { ms: 100, out: model } });
		expect(r.verdict).toBe("NO WIN");
		expect(r.decisionMismatches).toBe(0);
		expect(r.perInput[0].baseline.decision).toBe("yes");
		expect(r.perInput[0].baseline.probability).toBe(0.81);
	});

	test("sampling is reported honestly, with a warning under 20 inputs", async () => {
		const r = await gate({ baseline: { ms: 100, out: yes() }, candidate: { ms: 60, out: yes() } });
		expect(r.sampling.samplesPerInput).toBe(1);
		expect(r.sampling.baselineTimedSamples).toBe(PROMPTS.length);
		expect(r.sampling.candidateTimedSamples).toBe(PROMPTS.length);
		expect(r.sampling.warnings[0]).toContain("fewer than 20");
		const ok: Sample = { ok: true, decision: "yes", latencyMs: 10 };
		expect(judge(Array(20).fill(ok), Array(20).fill(ok), T).sampling.warnings).toEqual([]);
	});

	test("one untimed warm-up call per side runs before timing", async () => {
		let t = 0;
		const calls: string[] = [];
		const caller: Caller = async (target) => {
			calls.push(target.label);
			t += calls.length <= 2 ? 5000 : 100; // a slow cold load must not reach p50
			return '{"decision":"yes","probability":0.9}';
		};
		const s = await runPaired({
			baseline: BASE,
			candidate: CAND,
			prompts: PROMPTS,
			caller,
			now: () => t,
			timeoutMs: 1000,
		});
		expect(calls.length).toBe(2 * PROMPTS.length + 2);
		expect(s.warmUp).toEqual({ baseline: true, candidate: true });
		expect(judge(s.baseline, s.candidate, T).baselineP50Ms).toBe(100);
	});

	test("the gate caller asks for deterministic JSON decoding", async () => {
		let body: Record<string, unknown> = {};
		let url = "";
		const fakeFetch = (async (u: string, init: RequestInit) => {
			url = u;
			body = JSON.parse(String(init.body));
			return new Response(JSON.stringify({ message: { content: '{"decision":"yes"}' } }));
		}) as unknown as typeof fetch;
		const out = await gateCaller(42, 1000, fakeFetch)(BASE, "Answer yes or no. Is it on?");
		expect(out).toBe('{"decision":"yes"}');
		expect(url).toBe("http://baseline/api/chat");
		expect(body.format).toBe("json");
		expect(body.options).toEqual({ temperature: 0, seed: 42 });
		expect((body.messages as { content: string }[])[0].content).toBe(GATE_SYSTEM_PROMPT);
		const failing = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
		expect(await gateCaller(42, 1000, failing)(BASE, "x")).toBeNull();
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

	test("real replies parse: code fences, whitespace, trailing punctuation", () => {
		expect(parseOutput('```json\n{"decision": "Yes", "probability": 0.7}\n```\n')).toEqual({
			decision: "yes",
			probability: 0.7,
		});
		expect(parseOutput('```\n{"decision":"no"}\n```')).toEqual({
			decision: "no",
			probability: undefined,
		});
		expect(parseOutput("Yes.").decision).toBe(parseOutput("yes").decision);
		expect(parseOutput(" No!\n").decision).toBe("no");
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
		expect(report.decoding).toEqual({
			endpoint: "/api/chat",
			format: "json",
			temperature: 0,
			seed: 8,
		});
		expect(report.warmUp.untimedCallsPerSide).toBe(1);
		expect(report.maxDriftUnmeasurable).toBe(false);
	});

	test("missing or empty suite file is a usage error and runs nothing", async () => {
		const { argv, out } = setup();
		let calls = 0;
		const counting: Caller = async () => {
			calls++;
			return "yes";
		};
		const i = argv.indexOf("--suite");
		const missing = [...argv];
		missing[i + 1] = join(tmpdir(), "no-such-suite.jsonl");
		expect(await main(missing, { EIGHT_SPEED_GATE: "1" }, counting)).toBe(EXIT.USAGE);
		writeFileSync(argv[i + 1], "\n\n");
		expect(await main(argv, { EIGHT_SPEED_GATE: "1" }, counting)).toBe(EXIT.USAGE);
		expect(calls).toBe(0);
		expect(existsSync(out)).toBe(false);
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
