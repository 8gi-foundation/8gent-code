/**
 * GoalPersistence tests.
 *
 * Verifies the SQLite persistence layer mirrors goal_runs + goal_events.
 * Uses an in-memory DB (`:memory:` is not suitable across reopens, so we
 * use a tmp file path to simulate process restart).
 *
 * Convention: bun:test, matches sibling goal-loop.test.ts and
 * packages/db/src/workspace-db.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceDb } from "../db/src/workspace-db";
import { GoalPersistence } from "./persistence";
import type { GoalEvent } from "./types";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-persistence-"));
	dbPath = path.join(tmpDir, "state.db");
});

afterEach(() => {
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

describe("GoalPersistence.createRun", () => {
	it("inserts a row into goal_runs and returns the runId", () => {
		const db = new WorkspaceDb({ dbPath });
		const p = new GoalPersistence(db);
		const runId = p.createRun({
			runId: "r1",
			sessionId: "s1",
			goalText: "ship the feature",
			budget: {
				turns: 12,
				tokens: 100_000,
				wallclockMs: 600_000,
				filesChanged: 50,
				egressBytes: 25 * 1024 * 1024,
				maxDissentStreak: 8,
			},
			executorModel: "executor-A",
			judgeModel: "judge-B",
		});
		expect(runId).toBe("r1");
		const row = p.getRun("r1");
		expect(row).not.toBeNull();
		expect(row?.sessionId).toBe("s1");
		expect(row?.goalText).toBe("ship the feature");
		expect(row?.status).toBe("pending");
		expect(row?.executorModel).toBe("executor-A");
		expect(row?.judgeModel).toBe("judge-B");
		db.close();
	});
});

describe("GoalPersistence.appendEvent", () => {
	it("assigns monotonic seq values per run", () => {
		const db = new WorkspaceDb({ dbPath });
		const p = new GoalPersistence(db);
		p.createRun({
			runId: "r2",
			sessionId: "s1",
			goalText: "x",
			budget: {
				turns: 3,
				tokens: 100,
				wallclockMs: 1000,
				filesChanged: 0,
				egressBytes: 0,
				maxDissentStreak: 8,
			},
			executorModel: "e",
			judgeModel: "j",
		});
		const e1 = p.appendEvent({ runId: "r2", kind: "run.started", payload: { goal: "x" } });
		const e2 = p.appendEvent({ runId: "r2", kind: "turn.requested", payload: { turn: 1 } });
		const e3 = p.appendEvent({ runId: "r2", kind: "turn.completed", payload: { turn: 1 } });
		expect(e1.seq).toBe(1);
		expect(e2.seq).toBe(2);
		expect(e3.seq).toBe(3);
		const events = p.listEventsForRun("r2");
		expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
		expect(events.map((e) => e.kind)).toEqual([
			"run.started",
			"turn.requested",
			"turn.completed",
		]);
		db.close();
	});

	it("supports fromSeq filter for incremental reads", () => {
		const db = new WorkspaceDb({ dbPath });
		const p = new GoalPersistence(db);
		p.createRun({
			runId: "r3",
			sessionId: "s1",
			goalText: "x",
			budget: {
				turns: 3,
				tokens: 100,
				wallclockMs: 1000,
				filesChanged: 0,
				egressBytes: 0,
				maxDissentStreak: 8,
			},
			executorModel: "e",
			judgeModel: "j",
		});
		for (let i = 0; i < 5; i++) {
			p.appendEvent({ runId: "r3", kind: "turn.requested", payload: { turn: i + 1 } });
		}
		const tail = p.listEventsForRun("r3", 3);
		expect(tail.map((e) => e.seq)).toEqual([3, 4, 5]);
		db.close();
	});
});

describe("GoalPersistence.markComplete", () => {
	it("writes stop_reason, status, ended_at", () => {
		const db = new WorkspaceDb({ dbPath });
		const p = new GoalPersistence(db);
		p.createRun({
			runId: "r4",
			sessionId: "s1",
			goalText: "x",
			budget: {
				turns: 3,
				tokens: 100,
				wallclockMs: 1000,
				filesChanged: 0,
				egressBytes: 0,
				maxDissentStreak: 8,
			},
			executorModel: "e",
			judgeModel: "j",
		});
		p.markComplete("r4", "completed", "judge_satisfied", 1234567890);
		const row = p.getRun("r4");
		expect(row?.status).toBe("completed");
		expect(row?.stopReason).toBe("judge_satisfied");
		expect(row?.endedAt).toBe(1234567890);
		db.close();
	});
});

describe("GoalPersistence durability across process restarts", () => {
	it("survives DB close + reopen", () => {
		const db1 = new WorkspaceDb({ dbPath });
		const p1 = new GoalPersistence(db1);
		p1.createRun({
			runId: "r5",
			sessionId: "s1",
			goalText: "survive",
			budget: {
				turns: 3,
				tokens: 100,
				wallclockMs: 1000,
				filesChanged: 0,
				egressBytes: 0,
				maxDissentStreak: 8,
			},
			executorModel: "e",
			judgeModel: "j",
		});
		p1.appendEvent({ runId: "r5", kind: "run.started", payload: { goal: "survive" } });
		p1.appendEvent({ runId: "r5", kind: "run.completed", payload: { status: "completed" } });
		p1.markComplete("r5", "completed", "judge_satisfied", 5555);
		db1.close();

		const db2 = new WorkspaceDb({ dbPath });
		const p2 = new GoalPersistence(db2);
		const row = p2.getRun("r5");
		expect(row?.goalText).toBe("survive");
		expect(row?.status).toBe("completed");
		const events: GoalEvent[] = p2.listEventsForRun("r5");
		expect(events.length).toBe(2);
		expect(events[0].kind).toBe("run.started");
		expect(events[1].kind).toBe("run.completed");
		db2.close();
	});
});

describe("GoalPersistence transactional append", () => {
	it("appendEvent + getRun do not interleave seq collisions", () => {
		const db = new WorkspaceDb({ dbPath });
		const p = new GoalPersistence(db);
		p.createRun({
			runId: "r6",
			sessionId: "s1",
			goalText: "x",
			budget: {
				turns: 3,
				tokens: 100,
				wallclockMs: 1000,
				filesChanged: 0,
				egressBytes: 0,
				maxDissentStreak: 8,
			},
			executorModel: "e",
			judgeModel: "j",
		});
		const seqs = new Set<number>();
		for (let i = 0; i < 20; i++) {
			const ev = p.appendEvent({ runId: "r6", kind: "turn.requested", payload: { i } });
			seqs.add(ev.seq);
		}
		expect(seqs.size).toBe(20);
		db.close();
	});
});
