/**
 * Shared on-disk score history for kernel turn scorers (issue #2750, Step 3).
 *
 * Extracted from `packages/kernel/judge.ts` so the local scorer
 * (`local-scorer.ts`) and the legacy cloud judge write the exact same
 * history file, and the production loop's trend/status reads stay
 * backend-agnostic. When the cloud judge path is removed (issue #2750,
 * Step 5) this store survives it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Which judge backend produced a score record. */
export type JudgeSource = "local" | "cloud";

export interface ScoreRecord {
	sessionId: string;
	turnIndex: number;
	model: string;
	prompt: string;
	response: string;
	scores: {
		executionSuccess: number;
		codeQuality: number;
		toolEfficiency: number;
		directness: number;
		overall: number;
	};
	timestamp: string;
	/**
	 * Which judge produced this record. Absent on records written before
	 * issue #2750 wired the local judge in.
	 */
	judgeSource?: JudgeSource;
}

export interface ScoreHistory {
	records: ScoreRecord[];
	stats: {
		totalScored: number;
		avgOverall: number;
		scoresByModel: Record<string, { avg: number; count: number }>;
	};
	updatedAt: string;
}

/** Default history file, shared by every judge backend. */
export const DEFAULT_HISTORY_PATH = ".8gent/kernel/score-history.json";

/** Rolling window: only the most recent records are kept on disk. */
const MAX_RECORDS = 500;

/** Load the history at `path`, or an empty history when missing/corrupt. */
export function loadScoreHistory(path: string): ScoreHistory {
	try {
		if (existsSync(path)) {
			return JSON.parse(readFileSync(path, "utf-8"));
		}
	} catch {}
	return {
		records: [],
		stats: { totalScored: 0, avgOverall: 0, scoresByModel: {} },
		updatedAt: "",
	};
}

/**
 * Append one record to the history at `path`, recompute stats over the
 * retained window, and persist. Creates the parent directory when needed.
 */
export function appendScoreRecord(path: string, record: ScoreRecord): void {
	const history = loadScoreHistory(path);
	history.records.push(record);

	if (history.records.length > MAX_RECORDS) {
		history.records = history.records.slice(-MAX_RECORDS);
	}

	history.stats.totalScored += 1;
	const allOverall = history.records.map((r) => r.scores.overall);
	history.stats.avgOverall =
		Math.round((allOverall.reduce((a, b) => a + b, 0) / allOverall.length) * 100) / 100;

	const byModel: Record<string, number[]> = {};
	for (const r of history.records) {
		if (!byModel[r.model]) byModel[r.model] = [];
		byModel[r.model].push(r.scores.overall);
	}
	history.stats.scoresByModel = {};
	for (const [model, scores] of Object.entries(byModel)) {
		history.stats.scoresByModel[model] = {
			avg: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100,
			count: scores.length,
		};
	}

	history.updatedAt = new Date().toISOString();

	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(history, null, 2));
}

/** Average overall score per day for the last `days` days with records. */
export function scoreTrend(
	path: string,
	days = 7,
): Array<{ date: string; avg: number; count: number }> {
	const history = loadScoreHistory(path);
	const grouped: Record<string, { total: number; count: number }> = {};

	for (const record of history.records) {
		const date = record.timestamp.split("T")[0];
		if (!grouped[date]) grouped[date] = { total: 0, count: 0 };
		grouped[date].total += record.scores.overall;
		grouped[date].count += 1;
	}

	return Object.entries(grouped)
		.map(([date, { total, count }]) => ({
			date,
			avg: Math.round((total / count) * 100) / 100,
			count,
		}))
		.slice(-days);
}
