/**
 * Integration test: GoalLoop wired to GoalPersistence + Ledger.
 *
 * Verifies:
 *   - Every event emitted by the loop hits both the SQLite persistence
 *     row store AND the on-disk hash-chained ledger.
 *   - The two stores agree on event count, kinds, and order.
 *   - Ledger.verify() is true after the loop terminates.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceDb } from "../db/src/workspace-db";
import { GoalLoop } from "./goal-loop";
import { Ledger } from "./ledger";
import { GoalPersistence } from "./persistence";
import type {
	ExecutorHandle,
	ExecutorTurnInput,
	ExecutorTurnOutput,
	GoalEvent,
	GoalEventSink,
	JudgeHandle,
	JudgeHandleInput,
	JudgeVerdict,
} from "./types";

const TEST_KEY = Buffer.from("a".repeat(64), "hex");

class TeeSink implements GoalEventSink {
	constructor(
		private readonly persistence: GoalPersistence,
		private readonly ledger: Ledger,
	) {}
	append(event: GoalEvent): void {
		this.persistence.appendEvent({
			runId: event.runId,
			kind: event.kind,
			payload: { ...event.payload, ts: event.ts },
		});
		this.ledger.append({ kind: event.kind, payload: event.payload });
	}
}

function mockExecutor(model = "executor-X"): ExecutorHandle {
	return {
		model,
		async turn(input: ExecutorTurnInput): Promise<ExecutorTurnOutput> {
			return {
				summary: `turn ${input.turn}`,
				tokensIn: 10,
				tokensOut: 20,
			};
		},
		abort() {},
	};
}

function mockJudge(
	verdicts: Array<Partial<JudgeVerdict> & { decision: JudgeVerdict["decision"] }>,
	model = "judge-Y",
): JudgeHandle {
	let i = 0;
	return {
		model,
		async score(_input: JudgeHandleInput): Promise<JudgeVerdict> {
			const v = verdicts[Math.min(i, verdicts.length - 1)];
			i += 1;
			return {
				decision: v.decision,
				confidence: v.confidence ?? 0.9,
				summary: v.summary ?? "verdict",
			};
		},
	};
}

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-int-"));
	dbPath = path.join(tmpDir, "state.db");
});

afterEach(() => {
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

describe("GoalLoop + persistence + ledger integration", () => {
	it("persistence and ledger see the same events in the same order", async () => {
		const db = new WorkspaceDb({ dbPath });
		const persistence = new GoalPersistence(db);
		const ledgerDir = path.join(tmpDir, "runs");
		fs.mkdirSync(ledgerDir, { recursive: true });

		persistence.createRun({
			runId: "r-int-1",
			sessionId: "sess-int",
			goalText: "make the integration green",
			budget: {
				turns: 5,
				tokens: 1000,
				wallclockMs: 10_000,
				filesChanged: 0,
				egressBytes: 0,
				maxDissentStreak: 8,
			},
			executorModel: "executor-X",
			judgeModel: "judge-Y",
		});

		const ledger = Ledger.open({
			runId: "r-int-1",
			baseDir: ledgerDir,
			key: TEST_KEY,
		});

		const loop = new GoalLoop({
			runId: "r-int-1",
			sessionId: "sess-int",
			goal: "make the integration green",
			executor: mockExecutor(),
			judge: mockJudge([{ decision: "continue" }, { decision: "satisfied", confidence: 0.9 }]),
			sink: new TeeSink(persistence, ledger),
			budget: { turns: 5 },
		});
		const receipt = await loop.run_();
		expect(receipt.status).toBe("completed");
		expect(receipt.stopReason).toBe("judge_satisfied");

		persistence.markComplete("r-int-1", "completed", "judge_satisfied", receipt.endedAt);

		const dbEvents = persistence.listEventsForRun("r-int-1");
		expect(dbEvents.length).toBeGreaterThan(0);
		const dbKinds = dbEvents.map((e) => e.kind);
		expect(dbKinds).toContain("run.started");
		expect(dbKinds).toContain("run.completed");

		// Ledger contains the same number of entries and same kind order.
		const v = ledger.verify();
		expect(v.ok).toBe(true);
		expect(v.count).toBe(dbEvents.length);
		ledger.close();

		const reopened = Ledger.open({
			runId: "r-int-1",
			baseDir: ledgerDir,
			key: TEST_KEY,
		});
		const ledgerEntries = reopened.readAll();
		expect(ledgerEntries.map((e) => e.kind)).toEqual(dbKinds);
		reopened.close();

		db.close();
	});
});
