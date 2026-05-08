/**
 * Result store.
 *
 * A run produces:
 *   <baseDir>/<runId>/cases.jsonl   one line per case, full result
 *   <baseDir>/<runId>/summary.json  aggregate summary (the JSON used for diffs)
 *   <baseDir>/latest.json           pointer to the most recent runId
 *
 * The JSONL layout is intentional: it streams cleanly, diffs cleanly with
 * `git diff --no-index`, and a partial run is still readable if the
 * process is killed mid-suite.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { CaseResult, RunSummary } from "./schema";

export interface StoreLayout {
	baseDir: string;
	runDir: string;
	casesPath: string;
	summaryPath: string;
	latestPath: string;
}

export function defaultBaseDir(): string {
	const dataDir = process.env.EIGHT_DATA_DIR || `${process.env.HOME}/.8gent`;
	return path.join(dataDir, "golden", "runs");
}

export function layoutFor(runId: string, baseDir = defaultBaseDir()): StoreLayout {
	const runDir = path.join(baseDir, runId);
	return {
		baseDir,
		runDir,
		casesPath: path.join(runDir, "cases.jsonl"),
		summaryPath: path.join(runDir, "summary.json"),
		latestPath: path.join(baseDir, "latest.json"),
	};
}

export function writeRun(
	summary: RunSummary,
	results: CaseResult[],
	baseDir = defaultBaseDir(),
): StoreLayout {
	const layout = layoutFor(summary.runId, baseDir);
	fs.mkdirSync(layout.runDir, { recursive: true });
	const lines = results.map((r) => JSON.stringify(r)).join("\n");
	fs.writeFileSync(layout.casesPath, lines + (lines.length > 0 ? "\n" : ""));
	fs.writeFileSync(layout.summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
	fs.writeFileSync(
		layout.latestPath,
		`${JSON.stringify({ runId: summary.runId, finishedAt: summary.finishedAt }, null, 2)}\n`,
	);
	return layout;
}

export interface LoadedRun {
	summary: RunSummary;
	results: CaseResult[];
}

export function loadRun(runId: string, baseDir = defaultBaseDir()): LoadedRun {
	const layout = layoutFor(runId, baseDir);
	const summary = JSON.parse(fs.readFileSync(layout.summaryPath, "utf8")) as RunSummary;
	const lines = fs
		.readFileSync(layout.casesPath, "utf8")
		.split("\n")
		.filter((l) => l.length > 0);
	const results = lines.map((l) => JSON.parse(l) as CaseResult);
	return { summary, results };
}

export function loadLatest(baseDir = defaultBaseDir()): LoadedRun | null {
	const layout = layoutFor("noop", baseDir);
	if (!fs.existsSync(layout.latestPath)) return null;
	const { runId } = JSON.parse(fs.readFileSync(layout.latestPath, "utf8")) as {
		runId: string;
	};
	return loadRun(runId, baseDir);
}

export interface SummaryDiff {
	runId: string;
	baselineRunId: string;
	scoreDelta: number;
	passedDelta: number;
	failedDelta: number;
	p50DeltaMs: number;
	p95DeltaMs: number;
	regressedCases: string[];
	improvedCases: string[];
}

export function diffRuns(current: LoadedRun, baseline: LoadedRun): SummaryDiff {
	const baselineByCase = new Map(baseline.results.map((r) => [r.caseId, r]));
	const regressed: string[] = [];
	const improved: string[] = [];
	for (const r of current.results) {
		const prev = baselineByCase.get(r.caseId);
		if (!prev) continue;
		if (prev.passed && !r.passed) regressed.push(r.caseId);
		if (!prev.passed && r.passed) improved.push(r.caseId);
	}
	return {
		runId: current.summary.runId,
		baselineRunId: baseline.summary.runId,
		scoreDelta: current.summary.score - baseline.summary.score,
		passedDelta: current.summary.passed - baseline.summary.passed,
		failedDelta: current.summary.failed - baseline.summary.failed,
		p50DeltaMs: current.summary.p50DurationMs - baseline.summary.p50DurationMs,
		p95DeltaMs: current.summary.p95DurationMs - baseline.summary.p95DurationMs,
		regressedCases: regressed,
		improvedCases: improved,
	};
}
