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
 *
 * Stream idle gap (#3553, on by default for the text-tool path since #3657):
 * with `idleMs`, a second timer is armed at the start and re-armed on every
 * body chunk. If it fires the request is torn down and the read rejects with
 * TurnTimeoutError(idleMs, label, "idle"). `timeoutMs` stays as the wall-clock
 * ceiling and fires as TurnTimeoutError(timeoutMs, label, "ceiling"). Only
 * pass `idleMs` for a STREAMED request: a non-streamed reply sends nothing
 * until it is done, so its whole generation would count as one quiet gap.
 */

import { TurnTimeoutError, resolveTurnTimeoutMs } from "../eight/turn-timeout";

/** The timer functions modelFetch schedules with. Tests inject a fake clock. */
export type ModelFetchTimers = {
	setTimeout: (fn: () => void, ms: number) => unknown;
	clearTimeout: (handle: unknown) => void;
};

export type ModelFetchOptions = {
	/** Limit for this request in ms. Default: resolveTurnTimeoutMs(). */
	timeoutMs?: number;
	/** Provider/model label for the timeout error message. */
	label?: string;
	/** Fail after this many ms with no bytes (re-armed per chunk). Default: off. */
	idleMs?: number;
	/** Timer source. Default: the global setTimeout/clearTimeout. */
	timers?: ModelFetchTimers;
};

export async function modelFetch(
	input: string | URL | Request,
	init: RequestInit = {},
	opts: ModelFetchOptions = {},
): Promise<Response> {
	const timeoutMs = opts.timeoutMs ?? resolveTurnTimeoutMs();
	const idleMs = opts.idleMs;
	const timers: ModelFetchTimers = opts.timers ?? {
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
	};
	const deadline = new AbortController();
	let firedBy: "ceiling" | "idle" | null = null;
	const fire = (by: "ceiling" | "idle") => {
		if (firedBy === null) firedBy = by;
		deadline.abort();
	};
	// The deadline also covers reading the body, so it stays armed after the
	// headers arrive. unref() so a finished request never holds the process open.
	const timer = timers.setTimeout(() => fire("ceiling"), timeoutMs);
	(timer as { unref?: () => void })?.unref?.();
	let idleTimer: unknown = null;
	const armIdle = () => {
		if (idleMs == null) return;
		if (idleTimer != null) timers.clearTimeout(idleTimer);
		idleTimer = timers.setTimeout(() => fire("idle"), idleMs);
		(idleTimer as { unref?: () => void })?.unref?.();
	};
	const stop = () => {
		timers.clearTimeout(timer);
		if (idleTimer != null) timers.clearTimeout(idleTimer);
	};
	// Only OUR limit becomes a timeout. A caller abort stays an abort.
	const asTimeout = (err: unknown): unknown => {
		if (!deadline.signal.aborted || init.signal?.aborted) return err;
		if (firedBy === "idle" && idleMs != null) {
			const what = `no output for ${idleMs}ms`;
			return new TurnTimeoutError(idleMs, opts.label ? `${opts.label}, ${what}` : what, "idle");
		}
		return new TurnTimeoutError(timeoutMs, opts.label, "ceiling");
	};
	armIdle();
	const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;

	let res: Response;
	try {
		// `timeout: false` is Bun-specific: it turns off the built-in 300 s cap.
		res = await fetch(input, { ...init, signal, timeout: false } as RequestInit);
	} catch (err) {
		stop();
		throw asTimeout(err);
	}
	if (idleMs == null) return res;
	if (!res.body) {
		stop();
		return res;
	}

	// Re-arm the idle gap on every chunk; any abort ends the read at once.
	armIdle();
	const reader = res.body.getReader();
	const aborted = new Promise<never>((_, reject) => {
		const onAbort = () => reject(signal.reason);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	aborted.catch(() => {});
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const chunk = await Promise.race([reader.read(), aborted]);
				if (chunk.done) {
					stop();
					controller.close();
					return;
				}
				armIdle();
				controller.enqueue(chunk.value);
			} catch (err) {
				stop();
				reader.cancel().catch(() => {});
				controller.error(asTimeout(err));
			}
		},
		cancel(reason) {
			stop();
			return reader.cancel(reason);
		},
	});
	return new Response(body, {
		status: res.status,
		statusText: res.statusText,
		headers: res.headers,
	});
}

/**
 * modelFetch shaped as a plain `fetch`, for SDKs that take a custom fetch
 * (the AI SDK's createOpenAICompatible). Uses the turn timeout as the limit.
 */
export const modelFetchAsFetch = ((input: string | URL | Request, init?: RequestInit) =>
	modelFetch(input, init)) as typeof fetch;
