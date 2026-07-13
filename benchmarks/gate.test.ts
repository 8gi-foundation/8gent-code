/**
 * Tests for the continuous public benchmark gate (frontier issue #2758, step 1).
 *
 * Covers the invariants the CI gate depends on:
 *   1. TSV parsing matches the exact columns harness-v2.ts writes.
 *   2. Category averaging is a straight mean, rounded to 2 decimals.
 *   3. A category with no ledger baseline bootstraps (recorded, never fails).
 *   4. A drop beyond the noise band fails; inside the band stays stable.
 *   5. --update semantics: only categories present in the fresh run change.
 *   6. The CLI never hard-fails when there is nothing to grade (no results file).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type CategoryAverage,
	type Ledger,
	compareToLedger,
	computeCategoryAverages,
	emptyLedger,
	loadLedger,
	parseResultsTsv,
	saveLedger,
	updateLedger,
} from "./gate";

function tsvRow(cells: (string | number)[]): string {
	return cells.join("\t");
}

const HEADER = [
	"benchmark_id",
	"category",
	"title",
	"difficulty",
	"model",
	"temperature",
	"score",
	"exec_score",
	"kw_score",
	"method",
	"passed_tests",
	"total_tests",
	"exec_duration_ms",
	"api_duration_ms",
	"prompt_tokens",
	"completion_tokens",
	"total_tokens",
	"timestamp",
];

function fakeResultsTsv(rows: { id: string; category: string; score: number }[]): string {
	const lines = [tsvRow(HEADER)];
	for (const r of rows) {
		lines.push(
			tsvRow([
				r.id,
				r.category,
				`title-${r.id}`,
				"medium",
				"fake/model:free",
				0.3,
				r.score,
				r.score,
				r.score,
				"execution+keyword",
				1,
				1,
				100,
				200,
				10,
				20,
				30,
				new Date(0).toISOString(),
			]),
		);
	}
	return lines.join("\n");
}

describe("parseResultsTsv", () => {
	test("parses rows matching harness-v2.ts's header", () => {
		const tsv = fakeResultsTsv([
			{ id: "BF001", category: "bug-fixing", score: 90 },
			{ id: "FS001", category: "fullstack", score: 70 },
		]);
		const rows = parseResultsTsv(tsv);
		expect(rows).toEqual([
			{ benchmarkId: "BF001", category: "bug-fixing", score: 90 },
			{ benchmarkId: "FS001", category: "fullstack", score: 70 },
		]);
	});

	test("returns empty array for header-only or empty input", () => {
		expect(parseResultsTsv(tsvRow(HEADER))).toEqual([]);
		expect(parseResultsTsv("")).toEqual([]);
	});

	test("skips rows with a non-numeric score instead of crashing", () => {
		const tsv = `${tsvRow(HEADER)}\n${tsvRow(["BF001", "bug-fixing", "t", "medium", "m", 0.3, "n/a", "", "", "keyword-only", "", "", "", 1, 1, 1, 1, new Date(0).toISOString()])}`;
		expect(parseResultsTsv(tsv)).toEqual([]);
	});

	test("throws when required columns are missing", () => {
		expect(() => parseResultsTsv("foo\tbar\nbaz\tqux")).toThrow(/missing required columns/);
	});
});

describe("computeCategoryAverages", () => {
	test("averages scores per category and rounds to 2 decimals", () => {
		const rows = parseResultsTsv(
			fakeResultsTsv([
				{ id: "A1", category: "agentic", score: 90 },
				{ id: "A2", category: "agentic", score: 91 },
				{ id: "B1", category: "bug-fixing", score: 100 },
			]),
		);
		const avgs = computeCategoryAverages(rows);
		expect(avgs).toEqual([
			{ category: "agentic", avgScore: 90.5, benchmarkCount: 2 },
			{ category: "bug-fixing", avgScore: 100, benchmarkCount: 1 },
		]);
	});

	test("empty input yields empty output", () => {
		expect(computeCategoryAverages([])).toEqual([]);
	});
});

describe("compareToLedger", () => {
	const current: CategoryAverage[] = [
		{ category: "agentic", avgScore: 80, benchmarkCount: 7 },
		{ category: "fullstack", avgScore: 60, benchmarkCount: 3 },
		{ category: "new-category", avgScore: 55, benchmarkCount: 2 },
	];

	const ledger: Ledger = {
		updatedAt: "2026-06-01T00:00:00.000Z",
		categories: {
			agentic: { avgScore: 79, benchmarkCount: 7 },
			fullstack: { avgScore: 70, benchmarkCount: 3 },
		},
	};

	test("stays stable inside the noise band", () => {
		const report = compareToLedger(current, ledger, 3);
		const agentic = report.comparisons.find((c) => c.category === "agentic")!;
		expect(agentic.status).toBe("stable");
		expect(agentic.delta).toBe(1);
	});

	test("flags a regression beyond the noise band and fails the gate", () => {
		const report = compareToLedger(current, ledger, 3);
		const fullstack = report.comparisons.find((c) => c.category === "fullstack")!;
		expect(fullstack.status).toBe("regression");
		expect(fullstack.delta).toBe(-10);
		expect(report.passed).toBe(false);
		expect(report.regressions.map((r) => r.category)).toEqual(["fullstack"]);
	});

	test("bootstraps a category with no baseline instead of failing it", () => {
		const report = compareToLedger(current, ledger, 3);
		const fresh = report.comparisons.find((c) => c.category === "new-category")!;
		expect(fresh.status).toBe("bootstrap");
		expect(fresh.baseline).toBeNull();
		expect(fresh.delta).toBeNull();
	});

	test("an empty ledger bootstraps every category and always passes", () => {
		const report = compareToLedger(current, emptyLedger(), 3);
		expect(report.comparisons.every((c) => c.status === "bootstrap")).toBe(true);
		expect(report.passed).toBe(true);
	});

	test("an improvement beyond the band is reported as improved, not a failure", () => {
		const improved: CategoryAverage[] = [{ category: "agentic", avgScore: 95, benchmarkCount: 7 }];
		const report = compareToLedger(improved, ledger, 3);
		expect(report.comparisons[0].status).toBe("improved");
		expect(report.passed).toBe(true);
	});

	test("a drop exactly at the noise band boundary stays stable (not <, strictly beyond)", () => {
		const atBand: CategoryAverage[] = [{ category: "agentic", avgScore: 76, benchmarkCount: 7 }];
		const report = compareToLedger(atBand, ledger, 3);
		expect(report.comparisons[0].delta).toBe(-3);
		expect(report.comparisons[0].status).toBe("stable");
		expect(report.passed).toBe(true);
	});
});

describe("updateLedger", () => {
	test("merges fresh averages into the ledger and stamps updatedAt", () => {
		const base = emptyLedger();
		const next = updateLedger(base, [{ category: "agentic", avgScore: 80, benchmarkCount: 7 }]);
		expect(next.categories.agentic).toEqual({ avgScore: 80, benchmarkCount: 7 });
		expect(next.updatedAt).not.toBeNull();
	});

	test("leaves categories absent from the fresh run untouched", () => {
		const base: Ledger = {
			updatedAt: "2026-01-01T00:00:00.000Z",
			categories: { "bug-fixing": { avgScore: 100, benchmarkCount: 3 } },
		};
		const next = updateLedger(base, [{ category: "agentic", avgScore: 80, benchmarkCount: 7 }]);
		expect(next.categories["bug-fixing"]).toEqual({ avgScore: 100, benchmarkCount: 3 });
		expect(next.categories.agentic).toEqual({ avgScore: 80, benchmarkCount: 7 });
	});
});

describe("ledger file I/O", () => {
	test("loadLedger returns an empty ledger when the file does not exist", () => {
		const dir = mkdtempSync(join(tmpdir(), "gate-ledger-"));
		const path = join(dir, "missing-ledger.json");
		try {
			expect(loadLedger(path)).toEqual(emptyLedger());
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("saveLedger then loadLedger round-trips", () => {
		const dir = mkdtempSync(join(tmpdir(), "gate-ledger-"));
		const path = join(dir, "ledger.json");
		try {
			const ledger = updateLedger(emptyLedger(), [
				{ category: "agentic", avgScore: 88, benchmarkCount: 7 },
			]);
			saveLedger(path, ledger);
			expect(existsSync(path)).toBe(true);
			expect(loadLedger(path)).toEqual(ledger);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a real committed scores/ledger.json (empty bootstrap) parses cleanly", () => {
		const path = join(import.meta.dir, "..", "scores", "ledger.json");
		const ledger = loadLedger(path);
		expect(ledger.categories).toEqual({});
	});
});
