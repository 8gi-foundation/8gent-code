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
