/**
 * useLilEightState - state machine for the LilEightBadge in the V2 chrome.
 *
 * Maps three real signals (messages, isProcessing, lastTurnEndedAt) to the
 * six-state alphabet the badge renders:
 *
 *   idle:     no active turn, no recent error, no recent done
 *   thinking: tool call started but no streaming output yet
 *   working:  agent is actively producing output
 *   done:     last turn ended ok within the last 3 seconds
 *   error:    last turn ended with error within the last 5 seconds
 *   sleep:    no input, no agent activity for >5 minutes
 *
 * Pure derivation - no side effects, no internal state beyond a tick to
 * re-evaluate sleep/done/error windows over time.
 */

import { useEffect, useState } from "react";
import type { LilEightState } from "../components/LilEightBadge.js";
import type { Message } from "../app.js";
import { isLocalTurnFailureReply } from "../../../../packages/eight/local-turn-error.js";

export interface LilEightInputs {
	messages: ReadonlyArray<Pick<Message, "role" | "content" | "toolSuccess" | "id">>;
	isProcessing: boolean;
	lastTurnEndedAt: number | null;
	lastTurnSuccess: boolean | null;
	now: number;
	/** ms since last user input or agent activity. */
	idleSinceMs: number;
}

const DONE_WINDOW_MS = 3_000;
const ERROR_WINDOW_MS = 5_000;
const SLEEP_AFTER_MS = 5 * 60_000;

/**
 * Pure helper. Given a snapshot of agent state, return the next badge state.
 * Exported separately from the hook so it can be unit tested without React.
 */
export function deriveLilEightState(input: LilEightInputs): LilEightState {
	const {
		messages,
		isProcessing,
		lastTurnEndedAt,
		lastTurnSuccess,
		now,
		idleSinceMs,
	} = input;

	if (isProcessing) {
		// Distinguish thinking (tool call started, no streaming output yet) from
		// working (assistant output is flowing). Heuristic: if the most recent
		// non-user message is a tool start with no following assistant content,
		// we are still thinking.
		const last = messages[messages.length - 1];
		if (last && last.role === "tool") {
			return "thinking";
		}
		return "working";
	}

	if (lastTurnEndedAt != null) {
		const elapsed = now - lastTurnEndedAt;
		if (lastTurnSuccess === false && elapsed < ERROR_WINDOW_MS) {
			return "error";
		}
		if (lastTurnSuccess !== false && elapsed < DONE_WINDOW_MS) {
			return "done";
		}
	}

	if (idleSinceMs > SLEEP_AFTER_MS) {
		return "sleep";
	}

	return "idle";
}

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

/**
 * React hook wrapper. Re-evaluates every second so the done/error windows
 * decay back to idle and the sleep window can engage on a quiet TUI.
 */
export function useLilEightState(
	input: Omit<LilEightInputs, "now">,
	enabled = true,
): LilEightState {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (!enabled) return;
		const id = setInterval(() => setTick((n) => n + 1), 1_000);
		return () => clearInterval(id);
	}, [enabled]);
	void tick;
	return deriveLilEightState({ ...input, now: Date.now() });
}

export const _testing = {
	DONE_WINDOW_MS,
	ERROR_WINDOW_MS,
	SLEEP_AFTER_MS,
};
