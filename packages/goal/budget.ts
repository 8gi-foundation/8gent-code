/**
 * Budget accounting for a goal run.
 *
 * Single rule: caps are checked BEFORE the next executor turn AND before the
 * judge is invoked. We never trust the judge to stop us. If a cap trips the
 * counters record which cap, and the loop terminates with the matching
 * `StopReason`.
 *
 * Per 8TO: hard turn cap is the floor that prevents the most expensive
 * failure mode (runaway loop). Token + wallclock are belt-and-braces.
 */

import {
	type Budget,
	type BudgetCounters,
	DEFAULT_BUDGET,
	type ExecutorTurnOutput,
	type StopReason,
} from "./types";

export function freshCounters(): BudgetCounters {
	return {
		turns: 0,
		tokens: 0,
		wallclockMs: 0,
		filesChanged: 0,
		egressBytes: 0,
		dissentStreak: 0,
	};
}

export function resolveBudget(input?: Budget): Required<Budget> {
	const merged: Required<Budget> = {
		turns: input?.turns ?? DEFAULT_BUDGET.turns,
		tokens: input?.tokens ?? DEFAULT_BUDGET.tokens,
		wallclockMs: input?.wallclockMs ?? DEFAULT_BUDGET.wallclockMs,
		filesChanged: input?.filesChanged ?? DEFAULT_BUDGET.filesChanged,
		egressBytes: input?.egressBytes ?? DEFAULT_BUDGET.egressBytes,
		maxDissentStreak: input?.maxDissentStreak ?? DEFAULT_BUDGET.maxDissentStreak,
	};
	if (merged.turns <= 0) {
		throw new Error("budget.turns must be > 0 (no unbounded runs)");
	}
	if (merged.maxDissentStreak <= 0) {
		throw new Error("budget.maxDissentStreak must be > 0");
	}
	return merged;
}

/**
 * Check whether starting the *next* turn would exceed any cap. Called
 * before requesting a turn from the executor. If something is tripped
 * the counters' `tripped` field is set and the caller should stop.
 */
export function shouldStop(
	counters: BudgetCounters,
	budget: Required<Budget>,
	startedAt: number,
	now: number = Date.now(),
): StopReason | null {
	if (counters.turns >= budget.turns) return setTripped(counters, "budget_turns");
	if (counters.tokens >= budget.tokens) return setTripped(counters, "budget_tokens");
	if (counters.filesChanged >= budget.filesChanged) {
		return setTripped(counters, "budget_files");
	}
	if (counters.egressBytes >= budget.egressBytes) {
		return setTripped(counters, "budget_egress");
	}
	if (now - startedAt >= budget.wallclockMs) {
		counters.wallclockMs = now - startedAt;
		return setTripped(counters, "budget_wallclock");
	}
	return null;
}

function setTripped(counters: BudgetCounters, reason: StopReason): StopReason {
	counters.tripped = reason;
	return reason;
}

/** Apply executor turn output to the running counters. */
export function recordTurn(
	counters: BudgetCounters,
	output: ExecutorTurnOutput,
	startedAt: number,
	now: number = Date.now(),
): void {
	counters.turns += 1;
	counters.tokens += (output.tokensIn ?? 0) + (output.tokensOut ?? 0);
	counters.filesChanged += output.filesChanged ?? 0;
	counters.egressBytes += output.egressBytes ?? 0;
	counters.wallclockMs = now - startedAt;
}

/** Track judge agreement streak. Returns the streak after applying. */
export function recordDissent(counters: BudgetCounters, judgeContinued: boolean): number {
	if (judgeContinued) {
		counters.dissentStreak += 1;
	} else {
		counters.dissentStreak = 0;
	}
	return counters.dissentStreak;
}

export function dissentExceeded(counters: BudgetCounters, budget: Required<Budget>): boolean {
	return counters.dissentStreak >= budget.maxDissentStreak;
}
