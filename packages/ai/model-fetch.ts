/**
 * 8gent AI - fetch for model generation calls.
 *
 * Bun's fetch aborts every request on its own after 300 s ("TimeoutError: The
 * operation timed out.") unless `timeout: false` is passed. For a model step
 * that is a hidden ceiling: a slow local model that needed 4m43s was killed at
 * exactly 300 s, and EIGHT_TURN_TIMEOUT_MS could not raise it.
 *
 * modelFetch disables Bun's timer and enforces our own limit with an
 * AbortSignal, so EIGHT_TURN_TIMEOUT_MS (resolveTurnTimeoutMs) is the single
 * source of truth for how long one model step may take. The request is never
 * unbounded: with no explicit `timeoutMs` the turn timeout applies.
 *
 * Errors:
 *  - our limit fired          -> TurnTimeoutError (carries timeoutMs)
 *  - the caller's signal fired -> the caller's abort, unchanged (ESC, breaker)
 *  - anything else            -> the underlying fetch error, unchanged
 */

import { TurnTimeoutError, resolveTurnTimeoutMs } from "../eight/turn-timeout";

export type ModelFetchOptions = {
	/** Limit for this request in ms. Default: resolveTurnTimeoutMs(). */
	timeoutMs?: number;
	/** Provider/model label for the timeout error message. */
	label?: string;
};

export async function modelFetch(
	input: string | URL | Request,
	init: RequestInit = {},
	opts: ModelFetchOptions = {},
): Promise<Response> {
	const timeoutMs = opts.timeoutMs ?? resolveTurnTimeoutMs();
	const deadline = new AbortController();
	// The deadline also covers reading the body, so it stays armed after the
	// headers arrive. unref() so a finished request never holds the process open.
	const timer = setTimeout(() => deadline.abort(), timeoutMs);
	(timer as { unref?: () => void }).unref?.();
	const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;

	try {
		// `timeout: false` is Bun-specific: it turns off the built-in 300 s cap.
		return await fetch(input, { ...init, signal, timeout: false } as RequestInit);
	} catch (err) {
		clearTimeout(timer);
		// Only OUR deadline becomes a timeout. A caller abort stays an abort.
		if (deadline.signal.aborted && !init.signal?.aborted) {
			throw new TurnTimeoutError(timeoutMs, opts.label);
		}
		throw err;
	}
}

/**
 * modelFetch shaped as a plain `fetch`, for SDKs that take a custom fetch
 * (the AI SDK's createOpenAICompatible). Uses the turn timeout as the limit.
 */
export const modelFetchAsFetch = ((input: string | URL | Request, init?: RequestInit) =>
	modelFetch(input, init)) as typeof fetch;
