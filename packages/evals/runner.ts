// ── Eval Runner ──────────────────────────────────────────────────
// Loads a golden set, runs each case against an executor, scores,
// and aggregates latency p50/p95/p99 + per-category pass rates.

import * as fs from "node:fs";
import { type ScorerOptions, scoreCase } from "./scorer.js";
import type {
	AgentExecutor,
	CaseRunResult,
	EvalReport,
	GoldenSet,
	GoldenTestCase,
	LatencyStats,
} from "./types.js";

export interface RunnerOptions {
	executor: AgentExecutor;
	goldenSet: GoldenSet;
	scorer?: ScorerOptions;
	/** Filter by category ids; empty = all. */
	categories?: string[];
	/** Filter by case ids; empty = all. */
	caseIds?: string[];
	/** Max parallel runs. Default 1 (sequential — keeps latency clean). */
	concurrency?: number;
	onCaseStart?: (c: GoldenTestCase) => void;
	onCaseEnd?: (r: CaseRunResult) => void;
}

export async function runEvals(opts: RunnerOptions): Promise<EvalReport> {
	const cases = opts.goldenSet.cases.filter((c) => {
		if (opts.categories?.length && !opts.categories.includes(c.category)) return false;
		if (opts.caseIds?.length && !opts.caseIds.includes(c.id)) return false;
		return true;
	});

	const concurrency = Math.max(1, opts.concurrency ?? 1);
	const results: CaseRunResult[] = [];

	const queue = [...cases];
	const workers: Promise<void>[] = [];

	for (let i = 0; i < concurrency; i++) {
		workers.push(
			(async () => {
				while (queue.length > 0) {
					const testCase = queue.shift();
					if (!testCase) return;
					opts.onCaseStart?.(testCase);
					const result = await runOneCase(testCase, opts);
					results.push(result);
					opts.onCaseEnd?.(result);
				}
			})(),
		);
	}

	await Promise.all(workers);

	results.sort(
		(a, b) =>
			opts.goldenSet.cases.findIndex((c) => c.id === a.case.id) -
			opts.goldenSet.cases.findIndex((c) => c.id === b.case.id),
	);

	return aggregate(results, opts);
}

async function runOneCase(testCase: GoldenTestCase, opts: RunnerOptions): Promise<CaseRunResult> {
	let timedOut = false;
	const exec = await runWithTimeout(
		() => opts.executor.execute(testCase.prompt, testCase.context),
		testCase.timeout_ms,
		() => {
			timedOut = true;
		},
	);

	if (timedOut) {
		const err = {
			output: "",
			toolCalls: [],
			filesTouched: [],
			latencyMs: testCase.timeout_ms,
			error: `timeout after ${testCase.timeout_ms}ms`,
		};
		const score = await scoreCase(testCase, err, opts.scorer);
		return { case: testCase, execution: err, score, timedOut: true };
	}

	const score = await scoreCase(testCase, exec, opts.scorer);
	return { case: testCase, execution: exec, score, timedOut: false };
}

function runWithTimeout<T>(fn: () => Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
	return new Promise<T>((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			onTimeout();
			resolve(undefined as unknown as T);
		}, ms);
		fn()
			.then((v) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(v);
			})
			.catch(() => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				onTimeout();
				resolve(undefined as unknown as T);
			});
	});
}

// ── Aggregate ────────────────────────────────────────────────────

function aggregate(results: CaseRunResult[], opts: RunnerOptions): EvalReport {
	const latencies = results.map((r) => r.execution.latencyMs).filter((n) => n >= 0);
	const passed = results.filter((r) => r.score.passed).length;
	const total = results.length;
	const meanScore = total === 0 ? 0 : results.reduce((s, r) => s + r.score.score, 0) / total;

	const categoryBreakdown: Record<string, { passed: number; total: number }> = {};
	for (const r of results) {
		const k = r.case.category;
		if (!categoryBreakdown[k]) categoryBreakdown[k] = { passed: 0, total: 0 };
		categoryBreakdown[k].total += 1;
		if (r.score.passed) categoryBreakdown[k].passed += 1;
	}

	return {
		version: opts.goldenSet.version,
		timestamp: new Date().toISOString(),
		executor: opts.executor.name,
		cases: results,
		summary: {
			total,
			passed,
			failed: total - passed,
			passRate: total === 0 ? 0 : passed / total,
			meanScore: Math.round(meanScore * 10) / 10,
			latency: latencyStats(latencies),
			categoryBreakdown,
		},
	};
}

export function latencyStats(values: number[]): LatencyStats {
	if (values.length === 0) {
		return { count: 0, mean: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0 };
	}
	const sorted = [...values].sort((a, b) => a - b);
	const pct = (p: number): number => {
		const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
		return sorted[idx]!;
	};
	const sum = sorted.reduce((s, v) => s + v, 0);
	return {
		count: sorted.length,
		mean: Math.round((sum / sorted.length) * 10) / 10,
		p50: pct(50),
		p95: pct(95),
		p99: pct(99),
		min: sorted[0]!,
		max: sorted[sorted.length - 1]!,
	};
}

// ── IO helpers ───────────────────────────────────────────────────

export function loadGoldenSet(path: string): GoldenSet {
	const raw = fs.readFileSync(path, "utf8");
	const parsed = JSON.parse(raw) as GoldenSet;
	if (!parsed.cases || !Array.isArray(parsed.cases)) {
		throw new Error(`Invalid golden set at ${path}: missing cases[]`);
	}
	return parsed;
}

export function writeReport(path: string, report: EvalReport): void {
	fs.writeFileSync(path, JSON.stringify(report, null, 2));
}
