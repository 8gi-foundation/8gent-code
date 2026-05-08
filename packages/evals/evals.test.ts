import { describe, expect, test } from "bun:test";
import {
	type GoldenTestCase,
	compare,
	createMockExecutor,
	latencyStats,
	loadGoldenSet,
	reportToSnapshot,
	runEvals,
	scoreCase,
} from "./index.js";

const sampleCase: GoldenTestCase = {
	id: "T1",
	name: "sample",
	category: "reasoning",
	prompt: "say hello",
	expected: {
		contains: ["hello"],
		not_contains: ["forbidden"],
	},
	timeout_ms: 5000,
};

describe("scorer", () => {
	test("scores a passing case", async () => {
		const score = await scoreCase(sampleCase, {
			output: "well, hello world",
			toolCalls: [],
			filesTouched: [],
			latencyMs: 12,
		});
		expect(score.passed).toBe(true);
		expect(score.score).toBeGreaterThan(0);
		expect(score.breakdown.contains.passed).toBe(true);
		expect(score.breakdown.notContains.passed).toBe(true);
	});

	test("fails when contains is missing", async () => {
		const score = await scoreCase(sampleCase, {
			output: "goodbye",
			toolCalls: [],
			filesTouched: [],
			latencyMs: 12,
		});
		expect(score.passed).toBe(false);
		expect(score.breakdown.contains.missed).toContain("hello");
	});

	test("fails when not_contains is violated", async () => {
		const score = await scoreCase(sampleCase, {
			output: "hello forbidden",
			toolCalls: [],
			filesTouched: [],
			latencyMs: 12,
		});
		expect(score.passed).toBe(false);
		expect(score.breakdown.notContains.violated).toContain("forbidden");
	});

	test("fails on execution error", async () => {
		const score = await scoreCase(sampleCase, {
			output: "",
			toolCalls: [],
			filesTouched: [],
			latencyMs: 0,
			error: "network down",
		});
		expect(score.passed).toBe(false);
		expect(score.score).toBe(0);
	});
});

describe("runner", () => {
	test("aggregates a tiny suite end-to-end", async () => {
		const executor = createMockExecutor();
		const goldenSet = {
			version: "test",
			updated: "2026-05-08",
			cases: [
				sampleCase,
				{
					...sampleCase,
					id: "T2",
					expected: { contains: ["never-going-to-match"] },
				},
			],
		};
		const report = await runEvals({ executor, goldenSet });
		expect(report.cases).toHaveLength(2);
		expect(report.summary.total).toBe(2);
		expect(report.summary.latency.count).toBe(2);
		expect(report.summary.categoryBreakdown.reasoning?.total).toBe(2);
	});

	test("filters by category", async () => {
		const executor = createMockExecutor();
		const goldenSet = {
			version: "test",
			updated: "2026-05-08",
			cases: [sampleCase, { ...sampleCase, id: "T2", category: "code_gen" as const }],
		};
		const report = await runEvals({
			executor,
			goldenSet,
			categories: ["code_gen"],
		});
		expect(report.cases).toHaveLength(1);
		expect(report.cases[0]?.case.id).toBe("T2");
	});

	test("times out a slow case", async () => {
		const slow = {
			name: "slow",
			async execute() {
				await new Promise((r) => setTimeout(r, 100));
				return {
					output: "hello",
					toolCalls: [],
					filesTouched: [],
					latencyMs: 100,
				};
			},
		};
		const goldenSet = {
			version: "test",
			updated: "2026-05-08",
			cases: [{ ...sampleCase, timeout_ms: 10 }],
		};
		const report = await runEvals({ executor: slow, goldenSet });
		expect(report.cases[0]?.timedOut).toBe(true);
		expect(report.cases[0]?.score.passed).toBe(false);
	});
});

describe("latencyStats", () => {
	test("computes percentiles", () => {
		const s = latencyStats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
		expect(s.count).toBe(10);
		expect(s.min).toBe(10);
		expect(s.max).toBe(100);
		expect(s.p50).toBeGreaterThanOrEqual(50);
		expect(s.p95).toBeGreaterThanOrEqual(90);
	});

	test("handles empty input", () => {
		const s = latencyStats([]);
		expect(s.count).toBe(0);
		expect(s.p95).toBe(0);
	});
});

describe("baseline.compare", () => {
	test("flags a passing-to-failing regression", async () => {
		const goldenSet = {
			version: "test",
			updated: "2026-05-08",
			cases: [sampleCase],
		};
		const goodExecutor = createMockExecutor();
		// Override so output contains "hello" — passing run
		goodExecutor.execute = async () => ({
			output: "hello world",
			toolCalls: [],
			filesTouched: [],
			latencyMs: 10,
		});
		const goodReport = await runEvals({ executor: goodExecutor, goldenSet });
		const baseline = reportToSnapshot(goodReport);

		const badExecutor = createMockExecutor();
		badExecutor.execute = async () => ({
			output: "goodbye",
			toolCalls: [],
			filesTouched: [],
			latencyMs: 10,
		});
		const badReport = await runEvals({ executor: badExecutor, goldenSet });

		const diff = compare(baseline, badReport);
		expect(diff.hasRegressions).toBe(true);
		expect(diff.regressions.find((r) => r.kind === "passing")).toBeDefined();
	});

	test("flags latency regression", async () => {
		const goldenSet = {
			version: "test",
			updated: "2026-05-08",
			cases: [sampleCase],
		};
		const fast = createMockExecutor();
		fast.execute = async () => ({
			output: "hello",
			toolCalls: [],
			filesTouched: [],
			latencyMs: 10,
		});
		const slow = createMockExecutor();
		slow.execute = async () => ({
			output: "hello",
			toolCalls: [],
			filesTouched: [],
			latencyMs: 50,
		});
		const baseline = reportToSnapshot(await runEvals({ executor: fast, goldenSet }));
		const cur = await runEvals({ executor: slow, goldenSet });
		const diff = compare(baseline, cur);
		expect(diff.regressions.find((r) => r.kind === "latency")).toBeDefined();
	});

	test("no regression when stable", async () => {
		const goldenSet = {
			version: "test",
			updated: "2026-05-08",
			cases: [sampleCase],
		};
		const exec = createMockExecutor();
		exec.execute = async () => ({
			output: "hello",
			toolCalls: [],
			filesTouched: [],
			latencyMs: 10,
		});
		const baseline = reportToSnapshot(await runEvals({ executor: exec, goldenSet }));
		const cur = await runEvals({ executor: exec, goldenSet });
		const diff = compare(baseline, cur);
		expect(diff.hasRegressions).toBe(false);
	});
});

describe("loadGoldenSet", () => {
	test("loads the canonical golden set with 20+ cases", () => {
		const set = loadGoldenSet("evals/golden-set.json");
		expect(set.cases.length).toBeGreaterThanOrEqual(20);
		const ids = new Set(set.cases.map((c) => c.id));
		expect(ids.size).toBe(set.cases.length);
		const categories = new Set(set.cases.map((c) => c.category));
		expect(categories.size).toBeGreaterThanOrEqual(3);
	});
});
