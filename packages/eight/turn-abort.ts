/**
 * 8gent Code - Settling an aborted or failed local turn
 *
 * Agent.abort() tears down the in-flight turn for three different reasons,
 * and only one of them is an error from the user's point of view:
 *
 *   user             ESC in the TUI, /stop over RPC, a tab closing. The
 *                    surface already says "Generation interrupted."; a second
 *                    bubble reporting "The operation was aborted" as a
 *                    failure is noise about something the user asked for.
 *   circuit-breaker  The loop detector stopped a runaway tool loop.
 *   session-watchdog A single turn ran past the session ceiling.
 *
 * The reason travels on the AbortSignal itself (AbortController.abort(reason))
 * so the catch block can read it after the controller field has been nulled.
 */

export const USER_ABORT = "user" as const;

export type AbortReason = typeof USER_ABORT | "circuit-breaker" | "session-watchdog";

/** True when the turn ended because the user asked it to. */
export function isUserAbort(signal: AbortSignal, err?: unknown): boolean {
	if (signal.aborted && signal.reason === USER_ABORT) return true;
	// An AbortError surfaced by fetch while the user's abort reason is on the
	// signal counts too; any other AbortError (timeout, breaker) does not.
	return isAbortError(err) && signal.reason === USER_ABORT;
}

export function isAbortError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"name" in err &&
		(err as { name?: unknown }).name === "AbortError"
	);
}

const REACHABILITY =
	/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|timed out|ETIMEDOUT|unable to connect|connection refused|failed to connect|able to access the url/i;

/**
 * Friendly text for a real failure of the local text-tool turn, in the shape
 * Agent.chat() normally returns so the TUI and the Pill render it cleanly
 * instead of a raw fetch error.
 */
export function describeLocalTurnFailure(err: unknown, endpoint: string): string {
	const raw = err instanceof Error ? err.message : String(err);
	return REACHABILITY.test(raw)
		? `The local model endpoint (${endpoint}) is not reachable. Is LM Studio or Ollama running? (${raw})`
		: `The local model turn could not complete: ${raw}`;
}

export interface SettleFailedLocalTurnOptions {
	err: unknown;
	signal: AbortSignal;
	endpoint: string;
	/** The agent's conversation history; a real failure is recorded here. */
	history: Array<{ role: string; content: string }>;
}

/**
 * Settle the catch of a local text-tool turn.
 *
 * A user abort returns an empty turn and records nothing: no assistant entry
 * claims a failure, and every surface that renders replies skips empty text.
 * Anything else becomes the friendly failure turn, pushed to history and
 * returned, exactly as before.
 */
export function settleFailedLocalTurn(opts: SettleFailedLocalTurnOptions): string {
	if (isUserAbort(opts.signal, opts.err)) return "";
	const friendly = describeLocalTurnFailure(opts.err, opts.endpoint);
	opts.history.push({ role: "assistant", content: friendly });
	return friendly;
}
