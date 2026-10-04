/**
 * Tests for the speed-change gate (#3467). FAKE caller and FAKE clock only:
 * no model is called, nothing is downloaded, files go to a temp dir.
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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
	loadTarget,
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
		const ok: Sample = { ok: true, decision: "yes", latencyMs: 10, probability: 0.9 };
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
		let redirect: string | undefined;
		const fakeFetch = (async (u: string, init: RequestInit) => {
			url = u;
			redirect = init.redirect;
			body = JSON.parse(String(init.body));
			return new Response(JSON.stringify({ message: { content: '{"decision":"yes"}' } }));
		}) as unknown as typeof fetch;
		const out = await gateCaller(42, 1000, fakeFetch)(BASE, "Answer yes or no. Is it on?");
		expect(out).toBe('{"decision":"yes"}');
		expect(url).toBe("http://baseline/api/chat");
		expect(redirect).toBe("error");
		expect(body.format).toBe("json");
		expect(body.options).toEqual({ temperature: 0, seed: 42 });
		expect((body.messages as { content: string }[])[0].content).toBe(GATE_SYSTEM_PROMPT);
		const failing = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
		expect(await gateCaller(42, 1000, failing)(BASE, "x")).toBeNull();
		const huge = JSON.stringify({ message: { content: "x".repeat(70 * 1024) } });
		const big = (async () => new Response(huge)) as unknown as typeof fetch;
		expect(await gateCaller(42, 1000, big)(BASE, "x")).toBeNull();
	});

	test("empty, missing, non-string or over-long decisions are failures, not decisions", async () => {
		for (const reply of [
			"",
			"  ",
			"...",
			'{"probability":0.9}',
			'{"decision":42}',
			'{"decision":""}',
		]) {
			expect(parseOutput(reply).error).toBeDefined();
		}
		expect(parseOutput("a".repeat(65)).error).toContain("longer than 64");
		expect(parseOutput("a".repeat(64)).decision).toBe("a".repeat(64));
		const r = await gate({
			baseline: { ms: 100, out: () => "" },
			candidate: { ms: 50, out: () => "" },
		});
		expect(r.verdict).toBe("REJECT");
		expect(r.failures).toBe(PROMPTS.length);
	});

	test("a 1 MB punctuation reply parses in a few ms", () => {
		const start = performance.now();
		expect(parseOutput("```".concat(".".repeat(1024 * 1024))).error).toBeDefined();
		expect(parseOutput(`yes${" .".repeat(512 * 1024)}`).decision).toBe("yes");
		expect(performance.now() - start).toBeLessThan(200);
	});

	test("no probability on either side: drift is not checked and says so", async () => {
		const r = await gate({
			baseline: { ms: 100, out: () => "yes" },
			candidate: { ms: 50, out: () => "Yes." },
		});
		expect(r.verdict).toBe("ACCEPT");
		expect(r.driftChecked).toBe(false);
		expect(r.sampling.warnings.join()).toContain("drift was not checked");
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
			JSON.stringify({ url: "http://127.0.0.1:11434", model: "base", label: "baseline" }),
		);
		writeFileSync(
			join(dir, "cand.json"),
			JSON.stringify({ url: "http://localhost:11435/", model: "cand", label: "candidate" }),
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
		return { argv, out, dir };
	}
	let log: ReturnType<typeof spyOn>;
	let err: ReturnType<typeof spyOn>;
	beforeEach(() => {
		log = spyOn(console, "log").mockImplementation(() => {});
		err = spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		log.mockRestore();
		err.mockRestore();
	});
	const ON = { EIGHT_SPEED_GATE: "1" };
	const swap = (argv: string[], flag: string, value: string) => {
		const a = [...argv];
		a[a.indexOf(flag) + 1] = value;
		return a;
	};
	const ok = () => fake({ baseline: { ms: 100, out: yes() }, candidate: { ms: 60, out: yes() } });

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

	test("sampling and warm-up warnings print next to the verdict", async () => {
		const { argv, out } = setup();
		const { now, caller } = fake({
			baseline: { ms: 100, out: yes() },
			candidate: { ms: 60, out: yes() },
		});
		let n = 0;
		const coldBaseline: Caller = (t, p) => (++n === 1 ? Promise.resolve(null) : caller(t, p));
		const code = await main(argv, { EIGHT_SPEED_GATE: "1" }, coldBaseline, now);
		const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
		expect(code).toBe(EXIT.ACCEPT);
		expect(printed).toContain("warning: suite has 4 inputs, fewer than 20");
		expect(printed).toContain(
			"warning: baseline warm-up failed: its first timed call likely includes model load",
		);
		expect(printed).not.toContain("candidate warm-up failed");
		expect(JSON.parse(readFileSync(out, "utf-8")).sampling.warnings).toHaveLength(2);
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

	test("target URLs: http(s) loopback origins only, unless --allow-remote", () => {
		const { dir } = setup();
		const cfg = (url: string) => {
			const p = join(dir, `t-${Math.random()}.json`);
			writeFileSync(p, JSON.stringify({ url, model: "m" }));
			return p;
		};
		for (const url of [
			"file:///etc/passwd",
			"http://127.0.0.1:11434/#",
			"http://127.0.0.1:11434/?",
			"http://user:pw@127.0.0.1:11434",
			"http://127.0.0.1:11434/v1",
			"http://169.254.169.254",
			"http://[fe80::1]",
			"http://example.com",
		]) {
			expect(() => loadTarget(cfg(url), "x", false)).toThrow();
		}
		for (const url of [
			"http://169.254.169.254",
			"http://[::ffff:169.254.169.254]",
			"http://[::169.254.169.254]",
			"http://[::ffff:0:169.254.169.254]",
			"http://[64:ff9b::169.254.169.254]",
			"http://[64:ff9b:1::a9fe:a9fe]",
			"http://[::ffff:10.0.0.1]",
			"http://[fd00:ec2::254]",
			"http://[fe80::1]",
		]) {
			expect(() => loadTarget(cfg(url), "x", true)).toThrow("is refused");
		}
		expect(loadTarget(cfg("http://[::ffff:127.0.0.1]:11434"), "x", false).url).toBe(
			"http://[::ffff:7f00:1]:11434",
		);
		expect(loadTarget(cfg("http://example.com"), "x", true).url).toBe("http://example.com");
		expect(err.mock.calls.map((c) => String(c[0])).join()).toContain(
			"remote host allowed for x: example.com",
		);
		expect(err.mock.calls.map((c) => String(c[0])).join()).toContain("hostnames are not resolved");
		expect(loadTarget(cfg("http://[::1]:11434"), "x", false).url).toBe("http://[::1]:11434");
		expect(loadTarget(cfg("HTTP://LOCALHOST:11434/"), "x", false).url).toBe(
			"http://localhost:11434",
		);
	});

	test("an unsafe URL is refused before any request, with no injected caller", async () => {
		const { argv, dir } = setup();
		writeFileSync(
			join(dir, "cand.json"),
			JSON.stringify({ url: "http://169.254.169.254", model: "m" }),
		);
		const f = spyOn(globalThis, "fetch").mockImplementation((() => {
			throw new Error("network must not be reached");
		}) as unknown as typeof fetch);
		const code = await main(argv, ON);
		const calls = f.mock.calls.length;
		f.mockRestore();
		expect(code).toBe(EXIT.USAGE);
		expect(calls).toBe(0);
	});

	test("--suite that is a directory, malformed or too long is a usage error", async () => {
		const { argv, dir, out } = setup();
		const { caller } = ok();
		expect(await main(swap(argv, "--suite", dir), ON, caller)).toBe(EXIT.USAGE);
		const bad = join(dir, "bad.jsonl");
		writeFileSync(bad, '{"prompt":"a"}\nnot json\n');
		expect(await main(swap(argv, "--suite", bad), ON, caller)).toBe(EXIT.USAGE);
		writeFileSync(bad, '{"prompt":"a"}\n{"text":"b"}\n');
		expect(await main(swap(argv, "--suite", bad), ON, caller)).toBe(EXIT.USAGE);
		writeFileSync(bad, Array(1001).fill('{"prompt":"a"}').join("\n"));
		expect(await main(swap(argv, "--suite", bad), ON, caller)).toBe(EXIT.USAGE);
		expect(existsSync(out)).toBe(false);
	});

	test("--out that is a directory, a symlink or an input is refused", async () => {
		const { argv, dir } = setup();
		const { caller } = ok();
		expect(await main(swap(argv, "--out", dir), ON, caller)).toBe(EXIT.USAGE);
		const link = join(dir, "link.json");
		symlinkSync(join(dir, "victim.json"), link);
		expect(await main(swap(argv, "--out", link), ON, caller)).toBe(EXIT.USAGE);
		expect(existsSync(join(dir, "victim.json"))).toBe(false);
		expect(await main(swap(argv, "--out", join(dir, "suite.jsonl")), ON, caller)).toBe(EXIT.USAGE);
		symlinkSync(dir, join(dir, "alias"));
		const viaAlias = join(dir, "alias", "suite.jsonl");
		expect(await main(swap(argv, "--out", viaAlias), ON, caller)).toBe(EXIT.USAGE);
		expect(readFileSync(join(dir, "suite.jsonl"), "utf-8")).toContain("prompt");
	});

	test("the report is written 0600; a failed write exits 5 after printing the verdict", async () => {
		const { argv, out, dir } = setup();
		const a = ok();
		expect(await main(argv, ON, a.caller, a.now)).toBe(EXIT.ACCEPT);
		expect(statSync(out).mode & 0o777).toBe(0o600);
		mkdirSync(join(dir, "ro"), { mode: 0o500 });
		const b = ok();
		const code = await main(swap(argv, "--out", join(dir, "ro", "r.json")), ON, b.caller, b.now);
		expect(code).toBe(EXIT.ERROR);
		const lines = log.mock.calls.map((c) => String(c[0]));
		expect(lines.filter((l) => l.startsWith("ACCEPT:"))).toHaveLength(2);
		expect(lines.filter((l) => l.startsWith("report:"))).toHaveLength(1);
	});

	test("a crash exits 5, never a verdict code", async () => {
		const { argv } = setup();
		const boom = () => {
			throw new Error("clock broke");
		};
		expect(await main(argv, ON, ok().caller, boom)).toBe(EXIT.ERROR);
	});

	test("--timeout-ms above the timer limit is a usage error", async () => {
		const { argv } = setup();
		expect(await main(swap(argv, "--timeout-ms", "2147483648"), ON, ok().caller)).toBe(EXIT.USAGE);
	});
});
