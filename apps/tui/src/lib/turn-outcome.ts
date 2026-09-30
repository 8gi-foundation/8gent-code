/**
 * How a turn ended. Lifted out of the Lil Eight badge's state machine when
 * the badge left the header (#3238); the app still needs it to mark a turn
 * as failed for the NOW strip.
 */

import { isLocalTurnFailureReply } from "../../../../packages/eight/local-turn-error.js";
import type { Message } from "../app.js";

/**
 * Did the turn that just ended fail? Judged by how the turn ended, not by
 * whether anything inside it went wrong.
 *
 * A failed or policy-blocked tool call mid-turn is part of normal work: the
 * agent reads the failure and carries on (a red `bun test` before the fix,
 * a blocked `cd` it retries another way). Counting any failure in the last
 * few messages as a failed turn is what lit the header `error` for 5 s
 * after a successful bugfix run (pilot run 2026-09-30_003815, l3-bugfix-m5:
 * two blocked calls, all tests green, reply delivered).
 *
 * The turn failed only when its last word is a failure:
 *   - the agent errored: an `[Error] ...` reply, the agent's own failed-turn
 *     reply ("The local model turn could not complete: ..."), or an
 *     error/failed system line,
 *   - or it stopped on a failed tool call and never replied.
 */
export function turnEndedInError(
	messages: ReadonlyArray<Pick<Message, "role" | "content" | "toolSuccess">>,
): boolean {
	const last = messages[messages.length - 1];
	if (!last) return false;
	if (last.role === "assistant") {
		return /^\s*\[Error\]/.test(last.content) || isLocalTurnFailureReply(last.content);
	}
	if (last.role === "system") return /error|failed|\[Agent not ready\]/i.test(last.content);
	if (last.role === "tool") return last.toolSuccess === false;
	return false;
}
