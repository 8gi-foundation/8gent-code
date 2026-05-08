/**
 * Runner + store tests against an in-memory stub transport. We don't
 * spin up a real AgentPool here - that's covered by the live `bun run
 * test:golden` invocation in CI.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentRunResult,
	type ChatTransport,
	type GoldenCase,
	diffRuns,
	loadCasesFromDirectory,
	loadRun,
	parseGoldenCase,
	runGolden,
	writeRun,
} from "../index";

function fixedTransport(map: Record<string, AgentRunResult>): ChatTransport {
	return {
		describe: () => ({ model: "fixed", runtime: "test" }),
		async run({ caseId, prompt }) {
			const r = map[caseId];
			if (!r) throw new Error(`no fixture for ${caseId}`);
			return { ...r, prompt };
		},
	};
}

const cases: GoldenCase[] = [
	parseGoldenCase({
		id: "alpha",
		title: "alpha",
		prompt: "hi",
		expect: { substrings: [{ value: "hello" }], latency: { wallMs: 1000 } },
	}),
	parseGoldenCase({
		id: "beta",
		title: "beta",
		prompt: "hi",
		expect: { substrings: [{ value: "world" }] },
	}),
	parseGoldenCase({
		id: "skipped",
		title: "skipped",
		prompt: "hi",
		expect: { substrings: [{ value: "x" }] },
		skip: true,
	}),
];

describe("runner - basic flow", () => {
	it("passes when fixtures match expectations", async () => {
		const t = fixedTransport({
			alpha: {
				caseId: "alpha",
				prompt: "hi",
				response: "hello there",
				durationMs: 50,
				toolCalls: [],
				promptTokensEstimate: 0,
				completionTokensEstimate: 0,
			},
			beta: {
				caseId: "beta",
				prompt: "hi",
				response: "wonderful world",
				durationMs: 50,
				toolCalls: [],
				promptTokensEstimate: 0,
				completionTokensEstimate: 0,
			},
		});
		const out = await runGolden({ cases, transport: t });
		expect(out.summary.totalCases).toBe(3);
		expect(out.summary.passed).toBe(2);
		expect(out.summary.failed).toBe(0);
		expect(out.summary.skipped).toBe(1);
		expect(out.results.length).toBe(2);
	});

	it("counts a fixture-mismatch as a failure", async () => {
		const t = fixedTransport({
			alpha: {
				caseId: "alpha",
				prompt: "hi",
				response: "goodbye",
				durationMs: 10,
				toolCalls: [],
				promptTokensEstimate: 0,
				completionTokensEstimate: 0,
			},
			beta: {
				caseId: "beta",
				prompt: "hi",
				response: "world",
				durationMs: 10,
				toolCalls: [],
				promptTokensEstimate: 0,
				completionTokensEstimate: 0,
			},
		});
		const out = await runGolden({ cases, transport: t });
		expect(out.summary.passed).toBe(1);
		expect(out.summary.failed).toBe(1);
	});

	it("converts thrown errors from the transport into failed cases", async () => {
		const t: ChatTransport = {
			describe: () => ({ model: "broken", runtime: "test" }),
			async run() {
				throw new Error("boom");
			},
		};
		const out = await runGolden({ cases: [cases[0]!], transport: t });
		expect(out.summary.failed).toBe(1);
		expect(out.results[0]?.error).toBe("boom");
	});

	it("respects the filter regex", async () => {
		const t = fixedTransport({
			alpha: {
				caseId: "alpha",
				prompt: "hi",
				response: "hello there",
				durationMs: 5,
				toolCalls: [],
				promptTokensEstimate: 0,
				completionTokensEstimate: 0,
			},
			beta: {
				caseId: "beta",
				prompt: "hi",
				response: "world",
				durationMs: 5,
				toolCalls: [],
				promptTokensEstimate: 0,
				completionTokensEstimate: 0,
			},
		});
		const out = await runGolden({ cases, transport: t, filter: /^alpha$/ });
		expect(out.summary.totalCases).toBe(1);
		expect(out.results.length).toBe(1);
		expect(out.results[0]?.caseId).toBe("alpha");
	});

	it("computes p50/p95 from the actual case durations", async () => {
		// Build 5 cases with durations 10, 20, 30, 40, 50.
		const big: GoldenCase[] = [10, 20, 30, 40, 50].map((d) =>
			parseGoldenCase({
				id: `c-${d}`,
				title: `c${d}`,
				prompt: "hi",
				expect: { substrings: [{ value: "ok" }] },
			}),
		);
		const t: ChatTransport = {
			describe: () => ({ model: "perf", runtime: "test" }),
			async run({ caseId, prompt }) {
				const dur = Number(caseId.split("-")[1]);
				return {
					caseId,
					prompt,
					response: "ok",
					durationMs: dur,
					toolCalls: [],
					promptTokensEstimate: 0,
					completionTokensEstimate: 0,
				};
			},
		};
		const out = await runGolden({ cases: big, transport: t });
		expect(out.summary.passed).toBe(5);
		// p50 of [10,20,30,40,50] is 30.
		expect(out.summary.p50DurationMs).toBe(30);
		expect(out.summary.p95DurationMs).toBeGreaterThanOrEqual(40);
	});
});

describe("store - write/read round trip + diffs", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "golden-test-"));
	beforeAll(() => {
		// no-op
	});
	afterAll(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("writes a run and reads it back identically", async () => {
		const t = fixedTransport({
			alpha: {
				caseId: "alpha",
				prompt: "hi",
				response: "hello there",
				durationMs: 50,
				toolCalls: [{ tool: "noop", durationMs: 1 }],
				promptTokensEstimate: 1,
				completionTokensEstimate: 2,
			},
			beta: {
				caseId: "beta",
				prompt: "hi",
				response: "wonderful world",
				durationMs: 75,
				toolCalls: [],
				promptTokensEstimate: 1,
				completionTokensEstimate: 2,
			},
		});
		const out = await runGolden({ cases, transport: t });
		const layout = writeRun(out.summary, out.results, tmp);
		expect(fs.existsSync(layout.summaryPath)).toBe(true);
		expect(fs.existsSync(layout.casesPath)).toBe(true);
		expect(fs.existsSync(layout.latestPath)).toBe(true);
		const loaded = loadRun(out.summary.runId, tmp);
		expect(loaded.summary.runId).toBe(out.summary.runId);
		expect(loaded.results.length).toBe(out.results.length);
	});

	it("diffRuns flags regressions and improvements", async () => {
		const baselineTransport = fixedTransport({
			alpha: {
				caseId: "alpha",
				prompt: "hi",
				response: "hello",
				durationMs: 100,
				toolCalls: [],
				promptTokensEstimate: 0,
				completionTokensEstimate: 0,
			},
			beta: {
				caseId: "beta",
				prompt: "hi",
				response: "nope",
				durationMs: 100,
				toolCalls: [],
				promptTokensEstimate: 0,
				completionTokensEstimate: 0,
			},
		});
		const currentTransport = fixedTransport({
			alpha: {
				caseId: "alpha",
				prompt: "hi",
				response: "no greeting",
				durationMs: 50,
				toolCalls: [],
				promptTokensEstimate: 0,
				completionTokensEstimate: 0,
			},
			beta: {
				caseId: "beta",
				prompt: "hi",
				response: "world",
				durationMs: 50,
				toolCalls: [],
				promptTokensEstimate: 0,
				completionTokensEstimate: 0,
			},
		});
		const baseline = await runGolden({ cases, transport: baselineTransport });
		const current = await runGolden({ cases, transport: currentTransport });
		const d = diffRuns(current, baseline);
		expect(d.regressedCases).toContain("alpha");
		expect(d.improvedCases).toContain("beta");
	});
});

describe("loadCasesFromDirectory - shipped seed cases parse", () => {
	const dir = path.join(import.meta.dir, "..", "cases");

	it("loads every shipped case under packages/golden/cases", () => {
		const loaded = loadCasesFromDirectory(dir);
		// We ship a baseline of 20+ golden cases per the spec.
		expect(loaded.length).toBeGreaterThanOrEqual(20);
		const ids = new Set(loaded.map((c) => c.id));
		// Smoke check a few we know exist.
		expect(ids.has("arithmetic-basic")).toBe(true);
		expect(ids.has("factual-capital-france")).toBe(true);
		expect(ids.has("refusal-no-credentials")).toBe(true);
	});

	it("every shipped regex pattern compiles in JS RegExp", () => {
		const loaded = loadCasesFromDirectory(dir);
		const failures: string[] = [];
		for (const c of loaded) {
			for (const r of c.expect.regexes) {
				try {
					new RegExp(r.pattern, r.flags ?? "");
				} catch (err) {
					failures.push(`${c.id}: /${r.pattern}/${r.flags ?? ""} - ${(err as Error).message}`);
				}
			}
		}
		if (failures.length > 0) {
			throw new Error(`invalid regex patterns:\n${failures.join("\n")}`);
		}
	});

	it("every shipped case id is unique", () => {
		const loaded = loadCasesFromDirectory(dir);
		const seen = new Map<string, number>();
		for (const c of loaded) {
			seen.set(c.id, (seen.get(c.id) ?? 0) + 1);
		}
		const dups = [...seen.entries()].filter(([_, n]) => n > 1);
		expect(dups).toEqual([]);
	});
});
