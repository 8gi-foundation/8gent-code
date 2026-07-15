import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFirstScorer, LocalJudgeUnavailableError, type TurnScorer } from "./local-scorer";
import { ProductionLoop } from "./loop";
import type { ScoreRecord } from "./score-history";

function record(overall: number, judgeSource: "local" | "cloud"): ScoreRecord {
	return {
		sessionId: "s1",
		turnIndex: 0,
		model: "m",
		prompt: "p",
		response: "r",
		scores: {
			executionSuccess: overall,
			codeQuality: overall,
			toolEfficiency: overall,
			directness: overall,
			overall,
		},
		timestamp: new Date().toISOString(),
		judgeSource,
	};
}

function fakeScorer(options: { available: boolean; record?: ScoreRecord }): TurnScorer & {
	scoreCalls: number;
} {
	const stub = {
		scoreCalls: 0,
		async score(): Promise<ScoreRecord> {
			stub.scoreCalls += 1;
			if (!options.record) throw new LocalJudgeUnavailableError("down");
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

function loopConfig(scorer: TurnScorer) {
	const dir = mkdtempSync(join(tmpdir(), "loop-scoring-"));
	return {
		scorer,
		judge: { historyPath: join(dir, "history.json") },
		training: { dataDir: join(dir, "training") },
	};
}

// The build-verify loop's self-evaluation seam (issue #2750, Step 3): every
// scored turn flows through the injected TurnScorer - in production a
// LocalFirstScorer whose primary backend is the on-device judge.
describe("ProductionLoop scoring", () => {
	test("processTurn scores through the local-first scorer and feeds training", async () => {
		// overall 0.6 sits inside the training buffer's min/max thresholds.
		const scorer = fakeScorer({ available: true, record: record(0.6, "local") });
		const loop = new ProductionLoop(loopConfig(scorer));

		const scored = await loop.processTurn("s1", 0, "m", "prompt", "response");

		expect(scored?.judgeSource).toBe("local");
		expect(scorer.scoreCalls).toBe(1);
		const status = await loop.getStatus();
		expect(status.training.bufferSize).toBe(1);
	});

	test("processTurn returns null instead of a fabricated score when no judge can score", async () => {
		const scorer = fakeScorer({ available: false });
		const loop = new ProductionLoop(loopConfig(scorer));

		const scored = await loop.processTurn("s1", 0, "m", "prompt", "response");

		expect(scored).toBeNull();
		const status = await loop.getStatus();
		expect(status.training.bufferSize).toBe(0);
	});

	test("the loop's default scorer wiring is a LocalFirstScorer", () => {
		// No injected scorer: the loop must build the local-first stack itself.
		const dir = mkdtempSync(join(tmpdir(), "loop-scoring-default-"));
		const loop = new ProductionLoop({
			judge: { historyPath: join(dir, "history.json") },
			training: { dataDir: join(dir, "training") },
		});
		// Private field, asserted via runtime shape: the wiring claim of this
		// slice is exactly "the loop self-evaluates through LocalFirstScorer".
		expect((loop as unknown as { judge: unknown }).judge).toBeInstanceOf(LocalFirstScorer);
	});
});
