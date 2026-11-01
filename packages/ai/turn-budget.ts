/**
 * 8gent AI - Whole-turn time budget nudge (issue #4418)
 *
 * The per-attempt timeout in packages/eight/turn-timeout.ts bounds ONE provider
 * call. It cannot save a turn made of many slow steps: a long reasoning task
 * can burn its whole wall-clock window exploring and end with nothing written.
 *
 * This is the missing half. Between steps (prepareStep) it checks elapsed time
 * against a turn budget. Once the turn is close to the end it injects ONE user
 * message telling the model to write its current best answer to the output the
 * task asked for, then carry on refining. A wrong answer on disk beats none.
 *
 * Not tied to any task or scenario: the model already knows what output the
 * task asked for, the nudge only tells it the time is nearly up.
 *
 * Budget: EIGHT_TURN_BUDGET_MS (default 25 min, inside the 30 min session
 * watchdog). Set 0 to disable.
 */

export const DEFAULT_TURN_BUDGET_MS = 1_500_000;
/** Fraction of the budget after which the nudge fires. */
export const NUDGE_FRACTION = 0.8;
/** Fraction of the budget the projected end of the reaction must not cross (the "will not fit" line). */
export const WONT_FIT_FRACTION = 0.95;
/**
 * Steps the slowest-so-far step is assumed to cost after the notice: one for the model to
 * read it and call write_file, one more for the answer to land. A single step (the old rule)
 * left no time to react: live pilot 2026-10-19 fired at 1446 s of 1500 s with 190-410 s steps.
 */
export const REACTION_STEPS = 2;

/** A budget drain: call it between steps; reset() restarts the clock for a new turn. */
export type BudgetDrain = (() => string[]) & { reset: () => void };

export function resolveTurnBudgetMs(env: Record<string, string | undefined> = process.env): number {
	const raw = env.EIGHT_TURN_BUDGET_MS;
	if (raw == null || raw === "") return DEFAULT_TURN_BUDGET_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TURN_BUDGET_MS;
	return Math.floor(parsed);
}

export function budgetNudgeText(elapsedMs: number, budgetMs: number): string {
	const mins = Math.max(1, Math.round((budgetMs - elapsedMs) / 60_000));
	return `[SYSTEM NOTICE - TIME BUDGET] About ${mins} minute(s) remain in this turn. Before anything else, write your current best answer to the output file or location the task asked for, even if it is only a best guess. Do it now with your next tool call. Then, if time remains, keep refining and overwrite it with any improvement.`;
}

/**
 * Build a steer source for the loop's existing steering path (steerMessages in
 * agent.ts). Returns the nudge text at most once: on the first step that starts
 * after 80% of the budget, or earlier when two of the slowest steps so far would not
 * fit in the remaining time (slow local models take minutes per step, so a pure
 * 80% line can be crossed inside a single step).
 *
 * The budget is per createEightAgent() agent. packages/eight/agent.ts
 * retryAgent/verifyAgent create fresh agents, so each gets a fresh budget (this
 * is not a whole-turn budget across retries). reset() restarts the clock and the
 * once-only flag so a reused agent gets a fresh budget on each generate().
 */
export function createBudgetDrain(opts: {
	budgetMs: number;
	startedAt?: number;
	now?: () => number;
	/** Per-model nudge point (#4439, packages/ai/harness-profile.ts); defaults to NUDGE_FRACTION. */
	nudgeFraction?: number;
}): BudgetDrain {
	const now = opts.now ?? Date.now;
	let startedAt = opts.startedAt ?? now();
	let fired = false;
	let lastStepStart = now();
	let longestStepMs = 0;

	const drain = () => {
		const t = now();
		longestStepMs = Math.max(longestStepMs, t - lastStepStart);
		lastStepStart = t;
		if (fired || opts.budgetMs <= 0) return [];
		const elapsed = t - startedAt;
		const late = elapsed >= opts.budgetMs * (opts.nudgeFraction ?? NUDGE_FRACTION);
		const wontFit = elapsed + longestStepMs * REACTION_STEPS >= opts.budgetMs * WONT_FIT_FRACTION;
		if (!late && !wontFit) return [];
		fired = true;
		return [budgetNudgeText(elapsed, opts.budgetMs)];
	};
	return Object.assign(drain, {
		reset: () => {
			// An explicit startedAt pins the clock to the caller's turn start.
			if (opts.startedAt === undefined) startedAt = now();
			fired = false;
			lastStepStart = now();
			longestStepMs = 0;
		},
	});
}
