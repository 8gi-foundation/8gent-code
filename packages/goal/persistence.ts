/**
 * GoalPersistence - SQLite mirror of /go runs and events.
 *
 * Backs the in-memory goal loop with durable storage. The daemon constructs
 * one of these per workspace DB; the loop writes through a sink that fans
 * out to both this and the on-disk ledger.
 *
 * Schema: see `packages/db/src/migrations.ts` v2.
 *
 * Out of scope: hash chain, signatures. Those live in `ledger.ts`. This is
 * a queryable mirror only - tampering with the DB is not a security event
 * the persistence layer detects. The ledger is the authoritative audit log.
 */

import type { WorkspaceDb } from "../db/src/workspace-db";
import type { Budget, GoalEvent, GoalEventKind, RunStatus, StopReason } from "./types";

export interface PersistedGoalRun {
	runId: string;
	sessionId: string;
	goalText: string;
	status: RunStatus;
	stopReason: StopReason | null;
	budgetTurns: number;
	budgetTokens: number | null;
	budgetWallclockMs: number | null;
	budgetFilesChanged: number | null;
	budgetEgressBytes: number | null;
	executorModel: string;
	judgeModel: string;
	startedAt: number | null;
	endedAt: number | null;
	createdAt: number;
}

export interface CreateRunInput {
	runId: string;
	sessionId: string;
	goalText: string;
	budget: Required<Budget>;
	executorModel: string;
	judgeModel: string;
	now?: number;
}

export interface AppendEventInput {
	runId: string;
	kind: GoalEventKind | string;
	payload: Record<string, unknown>;
	now?: number;
}

interface GoalRunRow {
	id: string;
	session_id: string;
	goal_text: string;
	status: string;
	stop_reason: string | null;
	budget_turns: number;
	budget_tokens: number | null;
	budget_wallclock_ms: number | null;
	budget_files_changed: number | null;
	budget_egress_bytes: number | null;
	executor_model: string;
	judge_model: string;
	started_at: number | null;
	ended_at: number | null;
	created_at: number;
}

interface GoalEventRow {
	run_id: string;
	seq: number;
	kind: string;
	payload: string;
	ts: number;
}

function rowToRun(row: GoalRunRow): PersistedGoalRun {
	return {
		runId: row.id,
		sessionId: row.session_id,
		goalText: row.goal_text,
		status: row.status as RunStatus,
		stopReason: row.stop_reason as StopReason | null,
		budgetTurns: row.budget_turns,
		budgetTokens: row.budget_tokens,
		budgetWallclockMs: row.budget_wallclock_ms,
		budgetFilesChanged: row.budget_files_changed,
		budgetEgressBytes: row.budget_egress_bytes,
		executorModel: row.executor_model,
		judgeModel: row.judge_model,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		createdAt: row.created_at,
	};
}

function rowToEvent(row: GoalEventRow): GoalEvent {
	let payload: Record<string, unknown> = {};
	try {
		payload = JSON.parse(row.payload) as Record<string, unknown>;
	} catch {
		payload = { _raw: row.payload };
	}
	return {
		runId: row.run_id,
		seq: row.seq,
		kind: row.kind as GoalEventKind,
		ts: row.ts,
		payload,
	};
}

export class GoalPersistence {
	constructor(private readonly workspace: WorkspaceDb) {}

	/**
	 * Insert a new goal_runs row. The runId is provided by the caller so
	 * the in-memory GoalLoop and the persisted row share an id without an
	 * extra round-trip. Returns the runId for convenience.
	 *
	 * All writes happen inside a single transaction so partial state cannot
	 * leak on crash.
	 */
	createRun(input: CreateRunInput): string {
		const now = input.now ?? Date.now();
		this.workspace.transaction(() => {
			this.workspace.db
				.prepare(
					`INSERT INTO goal_runs (
						id, session_id, goal_text, status, stop_reason,
						budget_turns, budget_tokens, budget_wallclock_ms,
						budget_files_changed, budget_egress_bytes,
						executor_model, judge_model, judge_verdict, receipt,
						started_at, ended_at, created_at
					) VALUES (?, ?, ?, 'pending', NULL,
						?, ?, ?, ?, ?,
						?, ?, NULL, NULL,
						NULL, NULL, ?)`,
				)
				.run(
					input.runId,
					input.sessionId,
					input.goalText,
					input.budget.turns,
					input.budget.tokens || null,
					input.budget.wallclockMs || null,
					input.budget.filesChanged || null,
					input.budget.egressBytes || null,
					input.executorModel,
					input.judgeModel,
					now,
				);
		});
		return input.runId;
	}

	/**
	 * Append a single event. The seq is assigned monotonically per runId
	 * (max(seq)+1). Both the seq lookup and the insert run inside one
	 * transaction so concurrent writers cannot collide.
	 */
	appendEvent(input: AppendEventInput): GoalEvent {
		const ts = input.now ?? Date.now();
		const payloadJson = JSON.stringify(input.payload ?? {});

		let written: GoalEvent | null = null;
		this.workspace.transaction(() => {
			const row = this.workspace.db
				.query<{ next: number }, [string]>(
					"SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM goal_events WHERE run_id = ?",
				)
				.get(input.runId);
			const seq = row?.next ?? 1;
			this.workspace.db
				.prepare(
					"INSERT INTO goal_events (run_id, seq, kind, payload, ts) VALUES (?, ?, ?, ?, ?)",
				)
				.run(input.runId, seq, input.kind, payloadJson, ts);
			written = {
				runId: input.runId,
				seq,
				kind: input.kind as GoalEventKind,
				ts,
				payload: input.payload,
			};
		});
		// transaction() returns void; we know the closure sets `written` synchronously.
		if (!written) {
			throw new Error("appendEvent: transaction did not produce a row");
		}
		return written;
	}

	/** Fetch a single run by id. */
	getRun(runId: string): PersistedGoalRun | null {
		const row = this.workspace.db
			.query<GoalRunRow, [string]>("SELECT * FROM goal_runs WHERE id = ?")
			.get(runId);
		return row ? rowToRun(row) : null;
	}

	/**
	 * List events for a run, optionally starting from a sequence number
	 * (inclusive). Useful for incremental streaming to UI subscribers.
	 */
	listEventsForRun(runId: string, fromSeq = 1): GoalEvent[] {
		const rows = this.workspace.db
			.query<GoalEventRow, [string, number]>(
				"SELECT * FROM goal_events WHERE run_id = ? AND seq >= ? ORDER BY seq ASC",
			)
			.all(runId, fromSeq);
		return rows.map(rowToEvent);
	}

	/** Mark a run as terminal with status, stopReason, and endedAt. */
	markComplete(
		runId: string,
		status: RunStatus,
		stopReason: StopReason,
		endedAt: number,
	): void {
		this.workspace.db
			.prepare(
				"UPDATE goal_runs SET status = ?, stop_reason = ?, ended_at = ? WHERE id = ?",
			)
			.run(status, stopReason, endedAt, runId);
	}

	/** Update started_at on the first run.started event. */
	markStarted(runId: string, startedAt: number): void {
		this.workspace.db
			.prepare(
				"UPDATE goal_runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?",
			)
			.run(startedAt, runId);
	}

	/** List runs for a session, most recent first. */
	listRunsForSession(sessionId: string, limit = 50): PersistedGoalRun[] {
		const rows = this.workspace.db
			.query<GoalRunRow, [string, number]>(
				"SELECT * FROM goal_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
			)
			.all(sessionId, limit);
		return rows.map(rowToRun);
	}
}
