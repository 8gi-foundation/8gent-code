/**
 * Goal-loop core types.
 *
 * The /go feature wraps an existing agent runner in an outer loop with three
 * roles, each behind a small interface:
 *
 *   - executor: takes a turn, returns work product + token usage
 *   - judge:    inspects the work, returns a structured verdict
 *   - sink:     append-only event log (8GO owns the ledger format)
 *
 * Everything here is pure logic. No fs, no network, no Bun globals. Handles
 * are injected by the daemon layer. That keeps the loop unit-testable with
 * mock executor + mock judge, and keeps blast radius zero outside this pkg.
 */

// ----- Run status state machine ------------------------------------------------

/**
 * Lifecycle of a goal run. Transitions are enforced by `state-machine.ts`.
 *
 *   pending -> running -> judging -> completed
 *                      \-> judging -> running   (judge says continue)
 *                      \-> failed              (executor threw)
 *                      \-> stopped             (budget exhausted | abort | judge dissent N times)
 */
export type RunStatus =
	| "pending"
	| "running"
	| "judging"
	| "completed"
	| "stopped"
	| "failed";

/** Reason a run terminated. Surfaces in the receipt for postmortem. */
export type StopReason =
	| "judge_satisfied"
	| "budget_turns"
	| "budget_tokens"
	| "budget_wallclock"
	| "budget_files"
	| "budget_egress"
	| "judge_dissent_streak"
	| "user_abort"
	| "executor_error"
	| "judge_error";

// ----- Budgets ----------------------------------------------------------------

/**
 * Hard caps on a single run. All caps are enforced BEFORE the judge is
 * called for the next turn (8TO mitigation: stop runaway loops without
 * needing the judge to be healthy).
 *
 * Any cap set to 0 or undefined is treated as "no limit", with the
 * exception of `turns` which defaults to `DEFAULT_BUDGET.turns` if not
 * provided. We never run an unbounded turn loop.
 */
export interface Budget {
	turns: number;
	tokens?: number;
	wallclockMs?: number;
	filesChanged?: number;
	egressBytes?: number;
	/**
	 * If the judge returns `continue` for this many consecutive turns
	 * without ever returning `satisfied` or `failed`, the loop stops with
	 * `judge_dissent_streak`. Prevents an over-cautious judge from running
	 * the executor to bankruptcy. Default 8.
	 */
	maxDissentStreak?: number;
}

export const DEFAULT_BUDGET: Required<Budget> = {
	turns: 12,
	tokens: 100_000,
	wallclockMs: 10 * 60 * 1000,
	filesChanged: 50,
	egressBytes: 25 * 1024 * 1024,
	maxDissentStreak: 8,
};

/** Running counters maintained across the loop. Mutated in-place. */
export interface BudgetCounters {
	turns: number;
	tokens: number;
	wallclockMs: number;
	filesChanged: number;
	egressBytes: number;
	dissentStreak: number;
	/** Set when a cap trips. Surfaces as `stopReason`. */
	tripped?: StopReason;
}

// ----- Judge verdict ----------------------------------------------------------

/**
 * Structured JSON the judge must return. Free-text `notes` is allowed but
 * is never the source of truth for control flow. The loop only branches on
 * `decision` + `confidence`.
 *
 * Different model from the executor is enforced in the GoalLoop constructor.
 */
export interface JudgeVerdict {
	/** Machine-readable next step. */
	decision: "satisfied" | "continue" | "failed";
	/** 0..1. Sub-threshold confidence on `satisfied` is treated as `continue`. */
	confidence: number;
	/** One-line summary for the receipt + UI. No em dashes. */
	summary: string;
	/** Optional structured criteria the judge scored against. */
	criteria?: Array<{ name: string; passed: boolean; weight?: number }>;
	/** Optional next-step guidance fed back into the executor as a sub-goal. */
	nextStep?: string;
	/** Free-form judge reasoning. Not parsed. */
	notes?: string;
}

/** Confidence floor for `satisfied` to actually terminate the loop. */
export const SATISFIED_CONFIDENCE_FLOOR = 0.75;

// ----- Executor + Judge handles ----------------------------------------------

/**
 * One executor turn. Pure I/O contract: in = prompt + history-handle, out =
 * work summary + usage. The handle is supplied by the daemon; in tests it
 * is a stub. No assumption about which model/agent runs underneath.
 */
export interface ExecutorTurnInput {
	goal: string;
	subgoal?: string;
	turn: number;
	/** Free-form context the loop wants to thread back in. */
	priorVerdict?: JudgeVerdict;
}

export interface ExecutorTurnOutput {
	/** Short summary of what the executor produced this turn. Fed to judge. */
	summary: string;
	/** Token usage for this turn. Required: drives budget. */
	tokensIn: number;
	tokensOut: number;
	/** Optional richer artifact reference (file paths, diff handle, etc.). */
	artifactRef?: string;
	/** Files the executor touched this turn (counts toward budget). */
	filesChanged?: number;
	/** Bytes sent over the network this turn (counts toward budget). */
	egressBytes?: number;
}

export interface ExecutorHandle {
	/** Model id the executor uses. Compared against judge to enforce diversity. */
	readonly model: string;
	/** Run one turn. Throws on hard failure. */
	turn(input: ExecutorTurnInput): Promise<ExecutorTurnOutput>;
	/** Cooperative abort - executor should drop work and reject in-flight turn. */
	abort(): void;
}

export interface JudgeHandleInput {
	goal: string;
	turn: number;
	executorOutput: ExecutorTurnOutput;
	history: Array<{ turn: number; summary: string; verdict?: JudgeVerdict }>;
}

export interface JudgeHandle {
	/** Model id the judge uses. Must differ from executor.model. */
	readonly model: string;
	/** Score the latest turn. Throws on hard failure. */
	score(input: JudgeHandleInput): Promise<JudgeVerdict>;
}

// ----- Events (append-only ledger - 8GO owns serialization format) ------------

export type GoalEventKind =
	| "run.started"
	| "turn.requested"
	| "turn.completed"
	| "judge.requested"
	| "judge.verdict"
	| "subgoal.injected"
	| "budget.tripped"
	| "run.aborted"
	| "run.completed"
	| "run.failed";

/**
 * Atomic event written to the append-only log. 8GO defines on-disk
 * serialization (HMAC chain, file rotation). The goal package only
 * produces these in-memory records.
 */
export interface GoalEvent {
	runId: string;
	seq: number;
	kind: GoalEventKind;
	ts: number;
	payload: Record<string, unknown>;
}

/** Sink the loop writes events into. Implementations: SQLite, file, memory. */
export interface GoalEventSink {
	append(event: GoalEvent): void | Promise<void>;
}

// ----- Receipt (final return value) -------------------------------------------

/**
 * Hand-back to the caller after the loop terminates. 8DO owns user-facing
 * verdict copy; this struct is the structured input that copy is rendered
 * from. No prose decisions here.
 */
export interface Receipt {
	runId: string;
	sessionId: string;
	goal: string;
	status: Exclude<RunStatus, "pending" | "running" | "judging">;
	stopReason: StopReason;
	/** Final judge verdict, if any was produced. */
	finalVerdict: JudgeVerdict | null;
	/** All turns executed. Indices 1..N. */
	turns: Array<{
		turn: number;
		executor: ExecutorTurnOutput;
		verdict: JudgeVerdict | null;
	}>;
	counters: BudgetCounters;
	startedAt: number;
	endedAt: number;
	durationMs: number;
	executorModel: string;
	judgeModel: string;
	/** Total tokens billable to this run (sum of executor + judge if tracked). */
	totalTokens: number;
}

// ----- GoalRun (in-memory record, mirrors goal_runs row) ---------------------

export interface GoalRun {
	id: string;
	sessionId: string;
	goal: string;
	status: RunStatus;
	stopReason: StopReason | null;
	budget: Required<Budget>;
	counters: BudgetCounters;
	executorModel: string;
	judgeModel: string;
	subgoals: string[];
	history: Array<{
		turn: number;
		executor: ExecutorTurnOutput;
		verdict: JudgeVerdict | null;
	}>;
	finalVerdict: JudgeVerdict | null;
	startedAt: number;
	endedAt: number | null;
	createdAt: number;
}
