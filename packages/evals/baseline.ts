// ── Baseline Comparison ──────────────────────────────────────────
// Snapshots and diffs eval reports. Used by CI to detect regressions
// before merge.

import * as fs from "node:fs";
import type { BaselineSnapshot, EvalReport, RegressionReport } from "./types.js";

/** Score drop tolerance. Anything > this counts as a regression. */
export const SCORE_REGRESSION_THRESHOLD = 5;
/** Latency increase tolerance (ratio). p95 going up >50% is a regression. */
export const LATENCY_REGRESSION_RATIO = 1.5;

export function reportToSnapshot(report: EvalReport): BaselineSnapshot {
	const perCase: BaselineSnapshot["perCase"] = {};
	for (const r of report.cases) {
		perCase[r.case.id] = {
			passed: r.score.passed,
			score: r.score.score,
			latencyMs: r.execution.latencyMs,
		};
	}
	return {
		version: report.version,
		createdAt: report.timestamp,
		executor: report.executor,
		perCase,
		summary: report.summary,
	};
}

export function loadBaseline(path: string): BaselineSnapshot | null {
	if (!fs.existsSync(path)) return null;
	try {
		return JSON.parse(fs.readFileSync(path, "utf8")) as BaselineSnapshot;
	} catch {
		return null;
	}
}

export function writeBaseline(path: string, snapshot: BaselineSnapshot): void {
	fs.writeFileSync(path, JSON.stringify(snapshot, null, 2));
}

export function compare(baseline: BaselineSnapshot, current: EvalReport): RegressionReport {
	const regressions: RegressionReport["regressions"] = [];
	const improvements: RegressionReport["improvements"] = [];

	for (const r of current.cases) {
		const id = r.case.id;
		const prev = baseline.perCase[id];
		if (!prev) continue;

		// 1. Was passing, now failing
		if (prev.passed && !r.score.passed) {
			regressions.push({
				caseId: id,
				kind: "passing",
				baseline: true,
				current: false,
				delta: -1,
			});
		} else if (!prev.passed && r.score.passed) {
			improvements.push({
				caseId: id,
				kind: "passing",
				baseline: false,
				current: true,
				delta: 1,
			});
		}

		// 2. Score change
		const scoreDelta = r.score.score - prev.score;
		if (scoreDelta < -SCORE_REGRESSION_THRESHOLD) {
			regressions.push({
				caseId: id,
				kind: "score",
				baseline: prev.score,
				current: r.score.score,
				delta: Math.round(scoreDelta * 10) / 10,
			});
		} else if (scoreDelta > SCORE_REGRESSION_THRESHOLD) {
			improvements.push({
				caseId: id,
				kind: "score",
				baseline: prev.score,
				current: r.score.score,
				delta: Math.round(scoreDelta * 10) / 10,
			});
		}

		// 3. Latency increase
		if (prev.latencyMs > 0 && r.execution.latencyMs > prev.latencyMs * LATENCY_REGRESSION_RATIO) {
			regressions.push({
				caseId: id,
				kind: "latency",
				baseline: prev.latencyMs,
				current: r.execution.latencyMs,
				delta: r.execution.latencyMs - prev.latencyMs,
			});
		}
	}

	return {
		regressions,
		improvements,
		hasRegressions: regressions.length > 0,
	};
}

export function formatRegressions(report: RegressionReport): string {
	if (!report.hasRegressions && report.improvements.length === 0) {
		return "No changes vs baseline.";
	}
	const lines: string[] = [];
	if (report.regressions.length > 0) {
		lines.push(`Regressions (${report.regressions.length}):`);
		for (const r of report.regressions) {
			lines.push(`  - ${r.caseId} [${r.kind}] ${r.baseline} -> ${r.current} (delta ${r.delta})`);
		}
	}
	if (report.improvements.length > 0) {
		lines.push(`Improvements (${report.improvements.length}):`);
		for (const r of report.improvements) {
			lines.push(`  + ${r.caseId} [${r.kind}] ${r.baseline} -> ${r.current} (delta ${r.delta})`);
		}
	}
	return lines.join("\n");
}
