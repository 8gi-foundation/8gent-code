/**
 * Goal-run state machine. Centralizes legal transitions so the loop and the
 * daemon RPC layer cannot disagree about what "running" means.
 *
 * Transitions:
 *   pending  -> running          (loop.start)
 *   running  -> judging          (turn complete, about to score)
 *   judging  -> running          (judge says continue)
 *   judging  -> completed        (judge says satisfied, confidence >= floor)
 *   judging  -> stopped          (dissent streak hit cap)
 *   running  -> stopped          (budget tripped before judge call, or user abort)
 *   judging  -> stopped          (user abort during judge)
 *   running  -> failed           (executor threw)
 *   judging  -> failed           (judge threw with no prior verdict)
 *
 * Terminal states: completed, stopped, failed. Once terminal, no further
 * transitions are accepted.
 */

import type { RunStatus } from "./types";

const TERMINAL: ReadonlySet<RunStatus> = new Set(["completed", "stopped", "failed"]);

const ALLOWED: Record<RunStatus, ReadonlySet<RunStatus>> = {
	pending: new Set<RunStatus>(["running", "stopped", "failed"]),
	running: new Set<RunStatus>(["judging", "stopped", "failed"]),
	judging: new Set<RunStatus>(["running", "completed", "stopped", "failed"]),
	completed: new Set<RunStatus>(),
	stopped: new Set<RunStatus>(),
	failed: new Set<RunStatus>(),
};

export class IllegalTransitionError extends Error {
	constructor(
		public readonly from: RunStatus,
		public readonly to: RunStatus,
	) {
		super(`illegal goal-run transition: ${from} -> ${to}`);
		this.name = "IllegalTransitionError";
	}
}

export function isTerminal(status: RunStatus): boolean {
	return TERMINAL.has(status);
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
	return ALLOWED[from]?.has(to) ?? false;
}

/**
 * Apply a transition. Throws `IllegalTransitionError` if `to` is not a
 * legal next state for `from`. Returns the new state on success.
 */
export function transition(from: RunStatus, to: RunStatus): RunStatus {
	if (!canTransition(from, to)) {
		throw new IllegalTransitionError(from, to);
	}
	return to;
}
