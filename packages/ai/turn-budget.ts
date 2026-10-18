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
 * after 80% of the budget, or earlier when the slowest step so far would not
 * fit in the remaining time (slow local models take minutes per step, so a pure
 * 80% line can be crossed inside a single step).
 */
export function createBudgetDrain(opts: {
	budgetMs: number;
	startedAt?: number;
	now?: () => number;
}): () => string[] {
	const now = opts.now ?? Date.now;
	const startedAt = opts.startedAt ?? now();
	let fired = false;
	let lastStepStart = now();
	let longestStepMs = 0;

	return () => {
		const t = now();
		longestStepMs = Math.max(longestStepMs, t - lastStepStart);
		lastStepStart = t;
		if (fired || opts.budgetMs <= 0) return [];
		const elapsed = t - startedAt;
		const late = elapsed >= opts.budgetMs * NUDGE_FRACTION;
		const wontFit = elapsed + longestStepMs >= opts.budgetMs * 0.95;
		if (!late && !wontFit) return [];
		fired = true;
		return [budgetNudgeText(elapsed, opts.budgetMs)];
	};
}
