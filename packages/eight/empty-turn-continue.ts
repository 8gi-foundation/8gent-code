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
 *
 * Length cut (#4452): a step that ends on finishReason "length" with no text
 * and no tool call spent its whole output budget thinking (cloud MiniMax M3,
 * arc2-a: 8191 of 8192 tokens reasoning). That continues too, even before any
 * tool ran, and the steer adds one line asking for action over more thinking.
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
	// Collapse whitespace, drop control and bidi characters, and turn " into ' so
	// the request cannot close the quote it sits in.
	const flat = request
		.replace(/\s+/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
		.replace(/"/g, "'")
		.trim();
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
/** Fixed start of the length-cut log line, so pilot logs can count the cuts. */
export const EMPTY_TURN_LENGTH_LOG = "[empty-turn] length cut";

export const EMPTY_TURN_LENGTH_LINE =
	"Your last step ran out of output space while thinking. Think less, act now: make the next tool call or write the deliverable directly.";

/** The parts of a generate result this reads beyond text; all optional. */
export interface EmptyTurnResult {
	text?: string;
	finishReason?: string;
	usage?: { outputTokens?: number };
	toolCalls?: unknown[];
}

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
	const log = input.log ?? console.log;
	const empty = (result.text ?? "").trim() === "";
	const end: EmptyTurnResult = result;
	const lengthCut = empty && end.finishReason === "length" && !end.toolCalls?.length;
	if (lengthCut) log(`${EMPTY_TURN_LENGTH_LOG} at ${end.usage?.outputTokens ?? "unknown"} tokens`);
	const budgetSpent = input.budgetMs > 0 && input.elapsedMs >= input.budgetMs;
	if (!empty || (input.toolCalls === 0 && !lengthCut) || input.isAborted() || budgetSpent) {
		return { result, continued: false };
	}
	const calls = input.toolCalls === 1 ? "1 tool call" : `${input.toolCalls} tool calls`;
	log(`${EMPTY_TURN_CONTINUE_LOG} after ${calls} with no reply - one extra generate`);
	const steer = lengthCut
		? `${emptyTurnSteer(input.request)} ${EMPTY_TURN_LENGTH_LINE}`
		: emptyTurnSteer(input.request);
	try {
		return { result: await input.generate(steer), continued: true };
	} catch (err) {
		// A stop during the continue belongs to the caller's stop path.
		if (input.isAborted()) throw err;
		log(`${EMPTY_TURN_CONTINUE_LOG} failed: ${err instanceof Error ? err.message : String(err)}`);
		return { result, continued: true };
	}
}
