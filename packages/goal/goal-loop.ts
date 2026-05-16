/**
 * GoalLoop - the orchestrator.
 *
 * Wires executor + judge + event sink + budget under a state machine.
 *
 *   loop:
 *     while (not terminal):
 *       check budget (BEFORE turn)
 *       executor.turn(...) -> output
 *       record turn against budget
 *       check budget (AFTER turn, before judge)
 *       judge.score(output) -> verdict
 *       branch on verdict.decision
 *
 * Notes for reviewers:
 *   - Executor + judge are injected. No fs, no network here.
 *   - Hard turn cap is checked at the top of every iteration. Even a
 *     misbehaving judge cannot get more turns than the cap.
 *   - Judge != executor enforced at construction (assertDistinctJudge).
 *   - Sub-goals injected mid-run are picked up on the next iteration via
 *     `injectSubgoal()`. Existing turn is allowed to complete first.
 *   - `abort()` is cooperative: the executor is told to drop in-flight
 *     work, the run transitions to `stopped` with reason `user_abort`.
 */

import {
	dissentExceeded,
	freshCounters,
	recordDissent,
	recordTurn,
	resolveBudget,
	shouldStop,
} from "./budget";
import { applyConfidenceFloor, assertDistinctJudge } from "./judge";
import { buildReceipt } from "./receipt";
import { isTerminal, transition } from "./state-machine";
import type {
	Budget,
	ExecutorHandle,
	ExecutorTurnInput,
	GoalEvent,
	GoalEventKind,
	GoalEventSink,
	GoalRun,
	JudgeHandle,
	JudgeVerdict,
	Receipt,
	StopReason,
} from "./types";

export interface GoalLoopOptions {
	runId: string;
	sessionId: string;
	goal: string;
	executor: ExecutorHandle;
	judge: JudgeHandle;
	sink: GoalEventSink;
	budget?: Budget;
	/** Override clock for tests. */
	now?: () => number;
}

export class GoalLoop {
	private readonly run: GoalRun;
	private readonly executor: ExecutorHandle;
	private readonly judge: JudgeHandle;
	private readonly sink: GoalEventSink;
	private readonly now: () => number;
	private seq = 0;
	private abortRequested = false;
	private pendingSubgoal: string | null = null;

	constructor(opts: GoalLoopOptions) {
		assertDistinctJudge(opts.executor.model, opts.judge.model);
		const budget = resolveBudget(opts.budget);
		this.executor = opts.executor;
		this.judge = opts.judge;
		this.sink = opts.sink;
		this.now = opts.now ?? Date.now;
		const ts = this.now();
		this.run = {
			id: opts.runId,
			sessionId: opts.sessionId,
			goal: opts.goal,
			status: "pending",
			stopReason: null,
			budget,
			counters: freshCounters(),
			executorModel: opts.executor.model,
			judgeModel: opts.judge.model,
			subgoals: [],
			history: [],
			finalVerdict: null,
			startedAt: ts,
			endedAt: null,
			createdAt: ts,
		};
	}

	/** Public read-only snapshot. Callers must not mutate. */
	snapshot(): Readonly<GoalRun> {
		return this.run;
	}

	/** Queue a subgoal to be injected on the next iteration. */
	injectSubgoal(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		this.pendingSubgoal = trimmed;
		this.run.subgoals.push(trimmed);
		void this.emit("subgoal.injected", { text: trimmed });
	}

	/** Cooperative abort. The current in-flight turn is told to drop. */
	abort(): void {
		this.abortRequested = true;
		try {
			this.executor.abort();
		} catch {
			// Best effort - executor.abort() must not throw, but be defensive.
		}
	}

	/**
	 * Run the loop to a terminal state. Returns the assembled receipt.
	 * Idempotent in the sense that once terminal, subsequent calls just
	 * re-return the receipt.
	 */
	async run_(): Promise<Receipt> {
		if (isTerminal(this.run.status)) return buildReceipt(this.run);

		this.run.status = transition(this.run.status, "running");
		this.run.startedAt = this.now();
		await this.emit("run.started", {
			goal: this.run.goal,
			budget: this.run.budget,
			executorModel: this.run.executorModel,
			judgeModel: this.run.judgeModel,
		});

		try {
			while (!isTerminal(this.run.status)) {
				// 1. Abort check BEFORE budget so abort wins ties.
				if (this.abortRequested) {
					await this.terminate("stopped", "user_abort", null);
					break;
				}

				// 2. Budget check BEFORE the executor is invoked.
				const tripped = shouldStop(this.run.counters, this.run.budget, this.run.startedAt, this.now());
				if (tripped) {
					await this.emit("budget.tripped", { reason: tripped });
					await this.terminate("stopped", tripped, this.run.finalVerdict);
					break;
				}

				// 3. Take a turn.
				const turnNo = this.run.counters.turns + 1;
				const turnInput: ExecutorTurnInput = {
					goal: this.run.goal,
					turn: turnNo,
					priorVerdict: this.run.finalVerdict ?? undefined,
					subgoal: this.pendingSubgoal ?? undefined,
				};
				if (this.pendingSubgoal) this.pendingSubgoal = null;
				await this.emit("turn.requested", { turn: turnNo, subgoal: turnInput.subgoal ?? null });

				let executorOutput;
				try {
					executorOutput = await this.executor.turn(turnInput);
				} catch (err) {
					await this.terminate("failed", "executor_error", this.run.finalVerdict, errMsg(err));
					break;
				}

				recordTurn(this.run.counters, executorOutput, this.run.startedAt, this.now());
				await this.emit("turn.completed", {
					turn: turnNo,
					summary: executorOutput.summary,
					tokensIn: executorOutput.tokensIn,
					tokensOut: executorOutput.tokensOut,
				});

				// 4. Budget check AFTER turn (before judge spend).
				const trippedAfter = shouldStop(
					this.run.counters,
					this.run.budget,
					this.run.startedAt,
					this.now(),
				);
				if (trippedAfter) {
					this.run.history.push({ turn: turnNo, executor: executorOutput, verdict: null });
					await this.emit("budget.tripped", { reason: trippedAfter });
					await this.terminate("stopped", trippedAfter, this.run.finalVerdict);
					break;
				}

				// 5. Judge.
				this.run.status = transition(this.run.status, "judging");
				await this.emit("judge.requested", { turn: turnNo });
				let verdict: JudgeVerdict;
				try {
					const raw = await this.judge.score({
						goal: this.run.goal,
						turn: turnNo,
						executorOutput,
						history: this.run.history.map((h) => ({
							turn: h.turn,
							summary: h.executor.summary,
							verdict: h.verdict ?? undefined,
						})),
					});
					// Defensive: apply confidence floor even if the judge handle
					// was constructed bypassing `makeJudgeHandle`. Belt-and-braces
					// for raw-handle implementations.
					verdict = applyConfidenceFloor(raw);
				} catch (err) {
					this.run.history.push({ turn: turnNo, executor: executorOutput, verdict: null });
					await this.terminate("failed", "judge_error", this.run.finalVerdict, errMsg(err));
					break;
				}

				this.run.history.push({ turn: turnNo, executor: executorOutput, verdict });
				this.run.finalVerdict = verdict;
				await this.emit("judge.verdict", {
					turn: turnNo,
					decision: verdict.decision,
					confidence: verdict.confidence,
					summary: verdict.summary,
				});

				// 6. Branch on verdict.
				if (verdict.decision === "satisfied") {
					await this.terminate("completed", "judge_satisfied", verdict);
					break;
				}
				if (verdict.decision === "failed") {
					await this.terminate("stopped", "judge_dissent_streak", verdict);
					break;
				}
				// continue path
				const streak = recordDissent(this.run.counters, true);
				if (dissentExceeded(this.run.counters, this.run.budget)) {
					await this.emit("budget.tripped", {
						reason: "judge_dissent_streak",
						streak,
					});
					await this.terminate("stopped", "judge_dissent_streak", verdict);
					break;
				}
				// loop back to running for next iteration
				this.run.status = transition(this.run.status, "running");
			}
		} catch (err) {
			// Defensive catch-all - if we throw out of the loop, fail safely
			// rather than leaving the state machine half-transitioned.
			if (!isTerminal(this.run.status)) {
				try {
					await this.terminate("failed", "executor_error", this.run.finalVerdict, errMsg(err));
				} catch {
					// Last-resort: force terminal state without going through transition().
					this.run.status = "failed";
					this.run.stopReason = "executor_error";
					this.run.endedAt = this.now();
				}
			}
		}

		return buildReceipt(this.run);
	}

	// ---- internals ----

	private async emit(kind: GoalEventKind, payload: Record<string, unknown>): Promise<void> {
		this.seq += 1;
		const event: GoalEvent = {
			runId: this.run.id,
			seq: this.seq,
			kind,
			ts: this.now(),
			payload,
		};
		try {
			await this.sink.append(event);
		} catch {
			// Sink failures must not crash the loop. The append-only ledger
			// is informational; loss is logged by the sink implementer.
		}
	}

	private async terminate(
		status: "completed" | "stopped" | "failed",
		reason: StopReason,
		finalVerdict: JudgeVerdict | null,
		errorMessage?: string,
	): Promise<void> {
		if (isTerminal(this.run.status)) return;
		this.run.status = transition(this.run.status, status);
		this.run.stopReason = reason;
		this.run.endedAt = this.now();
		this.run.finalVerdict = finalVerdict;
		const kind: GoalEventKind =
			status === "completed"
				? "run.completed"
				: status === "failed"
					? "run.failed"
					: reason === "user_abort"
						? "run.aborted"
						: "run.completed";
		await this.emit(kind, {
			status,
			stopReason: reason,
			error: errorMessage,
			finalVerdict: finalVerdict ?? undefined,
		});
	}
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
