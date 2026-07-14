import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JudgeVerdict } from "../eight/verdict";
import {
	CRITERIA_ORDER,
	LocalFirstScorer,
	LocalJudgeUnavailableError,
	LocalTurnScorer,
	type TurnScorer,
	type VerdictJudge,
	buildCriterionRubric,
} from "./local-scorer";
import { type ScoreRecord, loadScoreHistory } from "./score-history";

function tmpHistoryPath(): string {
	return join(mkdtempSync(join(tmpdir(), "local-scorer-")), "history.json");
}

function passVerdict(): JudgeVerdict {
	return { pass: true, rationale: "meets the rubric", raw: "VERDICT: PASS", source: "selene" };
}

function failVerdict(): JudgeVerdict {
	return { pass: false, rationale: "misses the rubric", raw: "VERDICT: FAIL", source: "selene" };
}

function failClosedVerdict(): JudgeVerdict {
	return {
		pass: false,
		rationale: "Judge unreachable: fetch failed",
		raw: "",
		source: "fail-closed",
	};
}

/**
 * Fake verdict backend: answers each criterion (in rubric text) from a map,
 * records every judge call so tests can assert what the judge actually saw.
 */
function fakeVerdict(
	byCriterion: Partial<Record<string, JudgeVerdict>>,
	options: { available?: boolean } = {},
): VerdictJudge & { calls: Array<{ output: string; rubric: string }>; probes: number } {
	const backend = {
		calls: [] as Array<{ output: string; rubric: string }>,
		probes: 0,
		async judge(output: string, rubric: string): Promise<JudgeVerdict> {
			backend.calls.push({ output, rubric });
			for (const [criterion, verdict] of Object.entries(byCriterion)) {
				if (rubric.includes(criterion) && verdict) return verdict;
			}
			return failClosedVerdict();
		},
		async isAvailable(): Promise<{ selene: boolean }> {
			backend.probes += 1;
			return { selene: options.available ?? true };
		},
	};
	return backend;
}

/** Rubric marker per criterion, taken from the real rubric statements. */
const MARKERS = {
	executionSuccess: "execute correctly",
	codeQuality: "well-structured",
	toolEfficiency: "efficiently",
	directness: "over-engineering",
};

describe("buildCriterionRubric", () => {
	test("contains the criterion statement and the task text", () => {
		const rubric = buildCriterionRubric("executionSuccess", "build a parser");
		expect(rubric).toContain("PASS only if");
		expect(rubric).toContain("execute correctly");
		expect(rubric).toContain("build a parser");
	});

	test("clamps an unbounded task prompt", () => {
		const rubric = buildCriterionRubric("codeQuality", "x".repeat(10_000));
		expect(rubric.length).toBeLessThan(2000);
	});
});

describe("LocalTurnScorer", () => {
	test("all criteria pass -> full local score, persisted with judgeSource local", async () => {
		const historyPath = tmpHistoryPath();
		const verdict = fakeVerdict({
			[MARKERS.executionSuccess]: passVerdict(),
			[MARKERS.codeQuality]: passVerdict(),
			[MARKERS.toolEfficiency]: passVerdict(),
			[MARKERS.directness]: passVerdict(),
		});
		const scorer = new LocalTurnScorer({ verdict, historyPath });

		const record = await scorer.score("s1", 0, "eight-1.0-q3:14b", "task", "answer");

		expect(record.scores).toEqual({
			executionSuccess: 1,
			codeQuality: 1,
			toolEfficiency: 1,
			directness: 1,
			overall: 1,
		});
		expect(record.judgeSource).toBe("local");
		expect(verdict.calls).toHaveLength(CRITERIA_ORDER.length);

		const history = loadScoreHistory(historyPath);
		expect(history.records).toHaveLength(1);
		expect(history.records[0].judgeSource).toBe("local");
	});

	test("mixed verdicts -> weighted overall with default weights", async () => {
		const verdict = fakeVerdict({
			[MARKERS.executionSuccess]: passVerdict(),
			[MARKERS.codeQuality]: failVerdict(),
			[MARKERS.toolEfficiency]: passVerdict(),
			[MARKERS.directness]: failVerdict(),
		});
		const scorer = new LocalTurnScorer({ verdict, historyPath: tmpHistoryPath() });

		const record = await scorer.score("s1", 0, "m", "task", "answer");

		// 0.4 * 1 + 0.2 * 0 + 0.2 * 1 + 0.2 * 0
		expect(record.scores.overall).toBe(0.6);
		expect(record.scores.executionSuccess).toBe(1);
		expect(record.scores.codeQuality).toBe(0);
	});

	test("a single fail-closed criterion counts 0, not 1 (silence is never approval)", async () => {
		const verdict = fakeVerdict({
			[MARKERS.executionSuccess]: passVerdict(),
			[MARKERS.codeQuality]: passVerdict(),
			[MARKERS.toolEfficiency]: passVerdict(),
			[MARKERS.directness]: failClosedVerdict(),
		});
		const scorer = new LocalTurnScorer({ verdict, historyPath: tmpHistoryPath() });

		const record = await scorer.score("s1", 0, "m", "task", "answer");
		expect(record.scores.directness).toBe(0);
		expect(record.scores.overall).toBe(0.8);
	});

	test("all criteria fail-closed -> throws and records nothing", async () => {
		const historyPath = tmpHistoryPath();
		const verdict = fakeVerdict({}); // every rubric falls through to fail-closed
		const scorer = new LocalTurnScorer({ verdict, historyPath });

		await expect(scorer.score("s1", 0, "m", "task", "answer")).rejects.toBeInstanceOf(
			LocalJudgeUnavailableError,
		);
		expect(existsSync(historyPath)).toBe(false);
	});

	test("judges the raw response but persists a redacted record", async () => {
		const historyPath = tmpHistoryPath();
		const secret = "sk-ABCDEFGHIJKLMNOPQRSTUVWX";
		const verdict = fakeVerdict({
			[MARKERS.executionSuccess]: passVerdict(),
			[MARKERS.codeQuality]: passVerdict(),
			[MARKERS.toolEfficiency]: passVerdict(),
			[MARKERS.directness]: passVerdict(),
		});
		const scorer = new LocalTurnScorer({ verdict, historyPath });

		const record = await scorer.score("s1", 0, "m", "task", `token is ${secret}`);

		// The local judge saw the real output (nothing leaves the device)...
		expect(verdict.calls[0].output).toContain(secret);
		// ...but the persisted record - which feeds the training buffer - did not.
		expect(record.response).not.toContain(secret);
		expect(record.response).toContain("[REDACTED");
		const onDisk = JSON.stringify(loadScoreHistory(historyPath));
		expect(onDisk).not.toContain(secret);
	});

	test("availability probe is cached within the TTL", async () => {
		const verdict = fakeVerdict({}, { available: true });
		const scorer = new LocalTurnScorer({
			verdict,
			historyPath: tmpHistoryPath(),
			availabilityTtlMs: 60_000,
		});

		expect(await scorer.isAvailable()).toBe(true);
		expect(await scorer.isAvailable()).toBe(true);
		expect(verdict.probes).toBe(1);
	});
});

// ── LocalFirstScorer ──────────────────────────────────────────────────

function stubScorer(options: {
	available: boolean;
	record?: ScoreRecord;
	throws?: Error;
}): TurnScorer & { scoreCalls: number } {
	const stub = {
		scoreCalls: 0,
		async score(): Promise<ScoreRecord> {
			stub.scoreCalls += 1;
			if (options.throws) throw options.throws;
			if (!options.record) throw new Error("stub has no record");
			return options.record;
		},
		async isAvailable(): Promise<boolean> {
			return options.available;
		},
		getScoreTrend(): Array<{ date: string; avg: number; count: number }> {
			return [];
		},
	};
	return stub;
}

function someRecord(judgeSource: "local" | "cloud"): ScoreRecord {
	return {
		sessionId: "s1",
		turnIndex: 0,
		model: "m",
		prompt: "p",
		response: "r",
		scores: { executionSuccess: 1, codeQuality: 1, toolEfficiency: 1, directness: 1, overall: 1 },
		timestamp: new Date().toISOString(),
		judgeSource,
	};
}

describe("LocalFirstScorer", () => {
	test("prefers the local judge when it is up; cloud is never called", async () => {
		const local = stubScorer({ available: true, record: someRecord("local") });
		const cloud = stubScorer({ available: true, record: someRecord("cloud") });
		const scorer = new LocalFirstScorer({ local, cloud });

		const record = await scorer.score("s1", 0, "m", "p", "r");
		expect(record.judgeSource).toBe("local");
		expect(local.scoreCalls).toBe(1);
		expect(cloud.scoreCalls).toBe(0);
	});

	test("falls back to the cloud judge when the local judge is down", async () => {
		const local = stubScorer({ available: false });
		const cloud = stubScorer({ available: true, record: someRecord("cloud") });
		const scorer = new LocalFirstScorer({ local, cloud });

		const record = await scorer.score("s1", 0, "m", "p", "r");
		expect(record.judgeSource).toBe("cloud");
		expect(local.scoreCalls).toBe(0);
	});

	test("falls back when the local judge dies mid-score with an unavailable error", async () => {
		const local = stubScorer({
			available: true,
			throws: new LocalJudgeUnavailableError("all criteria fail-closed"),
		});
		const cloud = stubScorer({ available: true, record: someRecord("cloud") });
		const scorer = new LocalFirstScorer({ local, cloud });

		const record = await scorer.score("s1", 0, "m", "p", "r");
		expect(record.judgeSource).toBe("cloud");
	});

	test("real local scoring errors propagate, no silent cloud fallback", async () => {
		const local = stubScorer({ available: true, throws: new Error("disk full") });
		const cloud = stubScorer({ available: true, record: someRecord("cloud") });
		const scorer = new LocalFirstScorer({ local, cloud });

		await expect(scorer.score("s1", 0, "m", "p", "r")).rejects.toThrow("disk full");
		expect(cloud.scoreCalls).toBe(0);
	});

	test("fails closed when local is down and cloud fallback is disabled", async () => {
		const local = stubScorer({ available: false });
		const cloud = stubScorer({ available: true, record: someRecord("cloud") });
		const scorer = new LocalFirstScorer({ local, cloud, allowCloudFallback: false });

		await expect(scorer.score("s1", 0, "m", "p", "r")).rejects.toBeInstanceOf(
			LocalJudgeUnavailableError,
		);
		expect(cloud.scoreCalls).toBe(0);
		expect(await scorer.isAvailable()).toBe(false);
	});

	test("isAvailable is true when either backend can score", async () => {
		const localDown = stubScorer({ available: false });
		const cloudUp = stubScorer({ available: true, record: someRecord("cloud") });
		expect(await new LocalFirstScorer({ local: localDown, cloud: cloudUp }).isAvailable()).toBe(
			true,
		);
		expect(await new LocalFirstScorer({ local: localDown }).isAvailable()).toBe(false);
	});
});
