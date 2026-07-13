#!/usr/bin/env bun
/**
 * benchmarks/gate.ts — Continuous public benchmark gate (frontier issue #2758, step 1)
 *
 * Reads a benchmark:v2 results TSV, aggregates an average score per
 * category, and compares that average to the checked-in scores/ledger.json
 * baseline. Hard-fails (exit 1) when any category regresses beyond the
 * noise band. Categories with no recorded baseline are bootstrapped
 * (recorded, not failed) so a brand-new category never blocks a PR.
 *
 * This module never fabricates scores: everything it reports comes from a
 * results TSV that harness-v2.ts actually wrote from real benchmark runs.
 * If no results file exists (e.g. no OPENROUTER_API_KEY in this CI
 * environment), the CLI exits 0 with a clear "gate skipped" notice rather
 * than pretending to have graded anything.
 *
 * Usage:
 *   bun run benchmarks/gate.ts [--results path] [--ledger path] [--noise-band N] [--update]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ── Types ───────────────────────────────────────────────────────────

export interface ResultRow {
	benchmarkId: string;
	category: string;
	score: number;
}

export interface CategoryAverage {
	category: string;
	avgScore: number;
	benchmarkCount: number;
}

export interface LedgerEntry {
	avgScore: number;
	benchmarkCount: number;
}

export interface Ledger {
	updatedAt: string | null;
	categories: Record<string, LedgerEntry>;
}

export type CategoryStatus = "bootstrap" | "regression" | "improved" | "stable";

export interface CategoryComparison {
	category: string;
	baseline: number | null;
	current: number;
	delta: number | null;
	status: CategoryStatus;
}

export interface GateReport {
	noiseBand: number;
	comparisons: CategoryComparison[];
	regressions: CategoryComparison[];
	passed: boolean;
}

export const DEFAULT_NOISE_BAND = 3;
export const DEFAULT_RESULTS_PATH = resolve(dirname(import.meta.dir), "benchmarks/results-v2.tsv");
export const DEFAULT_LEDGER_PATH = resolve(dirname(import.meta.dir), "scores/ledger.json");

// ── Parsing ─────────────────────────────────────────────────────────

/** Parses a benchmark:v2 results TSV (see harness-v2.ts initResultsFile) into rows. */
export function parseResultsTsv(tsv: string): ResultRow[] {
	const lines = tsv.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length < 2) return [];

	const header = lines[0].split("\t");
	const idIdx = header.indexOf("benchmark_id");
	const catIdx = header.indexOf("category");
	const scoreIdx = header.indexOf("score");

	if (idIdx === -1 || catIdx === -1 || scoreIdx === -1) {
		throw new Error("results TSV missing required columns: benchmark_id, category, score");
	}

	const rows: ResultRow[] = [];
	for (const line of lines.slice(1)) {
		const cells = line.split("\t");
		const score = Number(cells[scoreIdx]);
		if (Number.isNaN(score)) continue;
		rows.push({
			benchmarkId: cells[idIdx],
			category: cells[catIdx],
			score,
		});
	}
	return rows;
}

/** Aggregates result rows into a mean score per category. */
export function computeCategoryAverages(rows: ResultRow[]): CategoryAverage[] {
	const byCategory = new Map<string, number[]>();
	for (const row of rows) {
		const list = byCategory.get(row.category) ?? [];
		list.push(row.score);
		byCategory.set(row.category, list);
	}

	return [...byCategory.entries()]
		.map(([category, scores]) => ({
			category,
			avgScore: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100,
			benchmarkCount: scores.length,
		}))
		.sort((a, b) => a.category.localeCompare(b.category));
}

// ── Ledger I/O ──────────────────────────────────────────────────────

export function emptyLedger(): Ledger {
	return { updatedAt: null, categories: {} };
}

export function loadLedger(path: string): Ledger {
	if (!existsSync(path)) return emptyLedger();
	const raw = JSON.parse(readFileSync(path, "utf-8"));
	return { updatedAt: raw.updatedAt ?? null, categories: raw.categories ?? {} };
}

export function saveLedger(path: string, ledger: Ledger): void {
	writeFileSync(path, `${JSON.stringify(ledger, null, "\t")}\n`);
}

// ── Comparison ──────────────────────────────────────────────────────

/**
 * Compares fresh category averages to the ledger baseline.
 * A category absent from the ledger is a bootstrap (recorded, never fails).
 * A category that drops by more than `noiseBand` points is a regression.
 */
export function compareToLedger(
	current: CategoryAverage[],
	ledger: Ledger,
	noiseBand: number = DEFAULT_NOISE_BAND,
): GateReport {
	const comparisons: CategoryComparison[] = current.map((c) => {
		const baseline = ledger.categories[c.category];
		if (!baseline) {
			return {
				category: c.category,
				baseline: null,
				current: c.avgScore,
				delta: null,
				status: "bootstrap",
			};
		}

		const delta = Math.round((c.avgScore - baseline.avgScore) * 100) / 100;
		let status: CategoryStatus = "stable";
		if (delta < -noiseBand) status = "regression";
		else if (delta > noiseBand) status = "improved";

		return {
			category: c.category,
			baseline: baseline.avgScore,
			current: c.avgScore,
			delta,
			status,
		};
	});

	const regressions = comparisons.filter((c) => c.status === "regression");

	return {
		noiseBand,
		comparisons,
		regressions,
		passed: regressions.length === 0,
	};
}

/** Merges fresh category averages into a ledger (used by --update / nightly runs). */
export function updateLedger(ledger: Ledger, current: CategoryAverage[]): Ledger {
	const categories = { ...ledger.categories };
	for (const c of current) {
		categories[c.category] = { avgScore: c.avgScore, benchmarkCount: c.benchmarkCount };
	}
	return { updatedAt: new Date().toISOString(), categories };
}

// ── Report formatting ──────────────────────────────────────────────

export function formatReport(report: GateReport): string {
	const lines: string[] = [];
	lines.push("═══════════════════════════════════════════════════════════════");
	lines.push("  Benchmark Gate — category scores vs scores/ledger.json");
	lines.push(`  Noise band: +/- ${report.noiseBand} points`);
	lines.push("═══════════════════════════════════════════════════════════════");

	for (const c of report.comparisons) {
		const symbol = c.status === "regression" ? "FAIL" : c.status === "bootstrap" ? "NEW " : "OK  ";
		const baselineStr = c.baseline === null ? "n/a" : c.baseline.toFixed(2);
		const deltaStr = c.delta === null ? "" : ` (${c.delta >= 0 ? "+" : ""}${c.delta.toFixed(2)})`;
		lines.push(
			`  [${symbol}] ${c.category.padEnd(24)} baseline=${baselineStr.padEnd(8)} current=${c.current.toFixed(2)}${deltaStr}`,
		);
	}

	lines.push("");
	if (report.passed) {
		lines.push("  Gate: PASS - no category regressed beyond the noise band.");
	} else {
		lines.push(`  Gate: FAIL - ${report.regressions.length} category regression(s):`);
		for (const r of report.regressions) {
			lines.push(`    - ${r.category}: ${r.baseline?.toFixed(2)} -> ${r.current.toFixed(2)}`);
		}
	}
	lines.push("═══════════════════════════════════════════════════════════════");
	return lines.join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
	const opts = {
		results: DEFAULT_RESULTS_PATH,
		ledger: DEFAULT_LEDGER_PATH,
		noiseBand: DEFAULT_NOISE_BAND,
		update: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--results") opts.results = resolve(argv[++i]);
		else if (arg === "--ledger") opts.ledger = resolve(argv[++i]);
		else if (arg === "--noise-band") opts.noiseBand = Number(argv[++i]);
		else if (arg === "--update") opts.update = true;
	}
	return opts;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));

	if (!existsSync(opts.results)) {
		console.log(
			`Benchmark gate skipped: no results file at ${opts.results}. Run \`bun run benchmark:v2\` first (requires OPENROUTER_API_KEY). Nothing to grade, nothing hard-failed.`,
		);
		process.exit(0);
	}

	const rows = parseResultsTsv(readFileSync(opts.results, "utf-8"));
	if (rows.length === 0) {
		console.log(`Benchmark gate skipped: ${opts.results} has no graded rows.`);
		process.exit(0);
	}

	const current = computeCategoryAverages(rows);
	const ledger = loadLedger(opts.ledger);
	const report = compareToLedger(current, ledger, opts.noiseBand);

	console.log(formatReport(report));

	if (opts.update) {
		const next = updateLedger(ledger, current);
		saveLedger(opts.ledger, next);
		console.log(`\nLedger updated: ${opts.ledger}`);
	} else {
		const bootstrapped = report.comparisons.filter((c) => c.status === "bootstrap");
		if (bootstrapped.length > 0 && join(opts.ledger) === join(DEFAULT_LEDGER_PATH)) {
			console.log(
				`\n${bootstrapped.length} new categor${bootstrapped.length === 1 ? "y has" : "ies have"} no baseline yet. Run with --update on a trusted (nightly/forge) run to seed scores/ledger.json.`,
			);
		}
	}

	process.exit(report.passed ? 0 : 1);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error("Fatal error in benchmark gate:", err);
		process.exit(1);
	});
}
