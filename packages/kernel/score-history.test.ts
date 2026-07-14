import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ScoreRecord, appendScoreRecord, loadScoreHistory, scoreTrend } from "./score-history";

function record(overrides: Partial<ScoreRecord> = {}): ScoreRecord {
	return {
		sessionId: "s1",
		turnIndex: 0,
		model: "test-model",
		prompt: "p",
		response: "r",
		scores: {
			executionSuccess: 1,
			codeQuality: 1,
			toolEfficiency: 1,
			directness: 1,
			overall: 1,
		},
		timestamp: "2026-07-14T10:00:00.000Z",
		...overrides,
	};
}

function tmpHistoryPath(): string {
	// A path inside a directory that does not exist yet, so append must mkdir.
	return join(mkdtempSync(join(tmpdir(), "score-history-")), "nested", "history.json");
}

describe("score-history", () => {
	test("loading a missing file returns an empty history", () => {
		const history = loadScoreHistory(tmpHistoryPath());
		expect(history.records).toEqual([]);
		expect(history.stats.totalScored).toBe(0);
	});

	test("append persists the record and recomputes stats", () => {
		const path = tmpHistoryPath();
		appendScoreRecord(path, record({ scores: { ...record().scores, overall: 0.8 } }));
		appendScoreRecord(
			path,
			record({ model: "other-model", scores: { ...record().scores, overall: 0.4 } }),
		);

		const history = loadScoreHistory(path);
		expect(history.records).toHaveLength(2);
		expect(history.stats.totalScored).toBe(2);
		expect(history.stats.avgOverall).toBe(0.6);
		expect(history.stats.scoresByModel["test-model"]).toEqual({ avg: 0.8, count: 1 });
		expect(history.stats.scoresByModel["other-model"]).toEqual({ avg: 0.4, count: 1 });
		expect(history.updatedAt).not.toBe("");
	});

	test("judgeSource round-trips through the store", () => {
		const path = tmpHistoryPath();
		appendScoreRecord(path, record({ judgeSource: "local" }));
		expect(loadScoreHistory(path).records[0].judgeSource).toBe("local");
	});

	test("history is capped at 500 records", () => {
		const path = tmpHistoryPath();
		// Seed a file with 500 records directly, then append one more.
		for (let i = 0; i < 3; i++) {
			appendScoreRecord(path, record({ turnIndex: i }));
		}
		const seeded = loadScoreHistory(path);
		seeded.records = Array.from({ length: 500 }, (_, i) => record({ turnIndex: i }));
		writeFileSync(path, JSON.stringify(seeded));
		appendScoreRecord(path, record({ turnIndex: 999 }));

		const history = loadScoreHistory(path);
		expect(history.records).toHaveLength(500);
		expect(history.records.at(-1)?.turnIndex).toBe(999);
	});

	test("scoreTrend groups by day and averages", () => {
		const path = tmpHistoryPath();
		appendScoreRecord(
			path,
			record({ timestamp: "2026-07-13T09:00:00.000Z", scores: { ...record().scores, overall: 1 } }),
		);
		appendScoreRecord(
			path,
			record({ timestamp: "2026-07-13T10:00:00.000Z", scores: { ...record().scores, overall: 0 } }),
		);
		appendScoreRecord(
			path,
			record({
				timestamp: "2026-07-14T10:00:00.000Z",
				scores: { ...record().scores, overall: 0.6 },
			}),
		);

		const trend = scoreTrend(path, 7);
		expect(trend).toEqual([
			{ date: "2026-07-13", avg: 0.5, count: 2 },
			{ date: "2026-07-14", avg: 0.6, count: 1 },
		]);
	});
});
