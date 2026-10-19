/**
 * Empty-turn auto-continue (#4444).
 *
 * The native tool loop can end a turn with tool work behind it and no text at
 * all (cloud pilot 2026-10-19, sigi-dev-arc2-a and arc1-b: ten tool calls, then
 * an empty final step, no answer file). The text-tool loop already re-asks on
 * an empty reply; the native path went straight to the "[harness] No reply"
 * note. This gives that turn ONE more generate with a short steer.
 *
 * Bounded by construction: one call site per turn and one generate here, no
 * recursion. A second empty end is returned as is and the caller shows the
 * No reply note. Never fires after a user abort or once the turn budget
 * (EIGHT_TURN_BUDGET_MS, #4419) is spent. Model-agnostic.
 */

/** Fixed start of every steer. */
export const EMPTY_TURN_CONTINUE_LEAD = "You ended without a reply.";

/** Characters of the person's request the steer quotes back. */
export const EMPTY_TURN_REQUEST_MAX = 400;

/**
 * The steer for one continue. A generic "finish the task" was not enough: a
 * live run (2026-10-19_152316) worked 43 more tool calls and ended empty again,
 * having lost what the deliverable was. So the steer quotes this turn's request
 * back, as data: whitespace collapsed, capped, nothing added to it.
 */
export function emptyTurnSteer(request: string): string {
	const flat = request.replace(/\s+/g, " ").trim();
	if (flat === "") {
		return `${EMPTY_TURN_CONTINUE_LEAD} Finish the task: produce the requested output (files or answer), then reply with a short summary.`;
	}
	const quoted =
		flat.length > EMPTY_TURN_REQUEST_MAX
			? `${flat.slice(0, EMPTY_TURN_REQUEST_MAX).trimEnd()}...`
			: flat;
	return `${EMPTY_TURN_CONTINUE_LEAD} The task was: "${quoted}". Produce the requested output now, then reply with a short summary.`;
}

/** Fixed start of the log line, so pilot logs can count the continues. */
export const EMPTY_TURN_CONTINUE_LOG = "[empty-turn] auto-continue";

export interface EmptyTurnContinueInput<R extends { text?: string }> {
	/** The turn's result as the loop returned it. */
	result: R;
	/** Tool calls this turn. Zero means nothing was started, so nothing to finish. */
	toolCalls: number;
	/** The person's request for this turn, quoted back in the steer. */
	request: string;
	/** True once the person stopped the turn (ESC, Ctrl+C). Read before and after the generate. */
	isAborted: () => boolean;
	/** Time since the turn started, and the turn budget (0 or less: no budget). */
	elapsedMs: number;
	budgetMs: number;
	/** Runs one more generate with the steer as the next user message. */
	generate: (steer: string) => Promise<R>;
	log?: (line: string) => void;
}

export async function continueEmptyTurn<R extends { text?: string }>(
	input: EmptyTurnContinueInput<R>,
): Promise<{ result: R; continued: boolean }> {
	const { result } = input;
	const empty = (result.text ?? "").trim() === "";
	const budgetSpent = input.budgetMs > 0 && input.elapsedMs >= input.budgetMs;
	if (!empty || input.toolCalls === 0 || input.isAborted() || budgetSpent) {
		return { result, continued: false };
	}
	const calls = input.toolCalls === 1 ? "1 tool call" : `${input.toolCalls} tool calls`;
	(input.log ?? console.log)(
		`${EMPTY_TURN_CONTINUE_LOG} after ${calls} with no reply - one extra generate`,
	);
	try {
		return { result: await input.generate(emptyTurnSteer(input.request)), continued: true };
	} catch (err) {
		// A stop during the continue belongs to the caller's stop path.
		if (input.isAborted()) throw err;
		(input.log ?? console.log)(
			`${EMPTY_TURN_CONTINUE_LOG} failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return { result, continued: true };
	}
}
