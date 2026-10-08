/**
 * 8gent Code - Per-attempt turn timeout
 *
 * Guarantees a single provider generate() attempt terminates. Without this,
 * an unreachable or stalled provider (an apple-foundation bridge that never
 * answers, an endpoint that accepts the socket but never streams, an invalid
 * model id whose client hangs) leaves the awaited generate() promise pending
 * for the full session watchdog window (30 min) - which is "forever" for a
 * WebSocket relay caller.
 *
 * The wrapper races the attempt against a wall-clock deadline. On timeout it
 * aborts the shared AbortController (so the underlying request is torn down)
 * and rejects with a clear TurnTimeoutError. The agent's failover loop treats
 * that rejection like any other provider error: mark the provider down, advance
 * the chain, and - once the bounded chain is exhausted - throw a clean
 * "All providers exhausted" error that unblocks the caller.
 *
 * Two policies live here:
 *
 *  - Native (non-streamed) path: one wall-clock bound per attempt,
 *    DEFAULT_TURN_TIMEOUT_MS (5 min), override with EIGHT_TURN_TIMEOUT_MS.
 *    A generate() that does not stream gives no progress signal, so total time
 *    is the only thing we can judge. 5 min is the compromise for a LOCAL-FIRST
 *    daemon: a cold local model on a busy machine can legitimately need that
 *    long for ONE attempt, while a dead provider still fails over in minutes
 *    and the worst case (every provider in the chain stalls) stays near the
 *    30 min watchdog. Fast cloud-only setups lower it.
 *
 *  - Text-tool path (local models: ollama, lmstudio, llama-server; #3657):
 *    the reply streams and a step fails on NO PROGRESS - no bytes for
 *    resolveStreamIdleMs() (default DEFAULT_STREAM_IDLE_MS) - not on total
 *    time. The wall clock becomes a much higher safety net,
 *    resolveStepCeilingMs() (default DEFAULT_STREAM_CEILING_MS). A thinking
 *    model that needs ten minutes of reasoning tokens before its first answer
 *    is never cut off while it is still writing, and a connection that goes
 *    quiet is still caught after one gap. EIGHT_TURN_TIMEOUT_MS, when set,
 *    stays the explicit ceiling for users who want a hard wall-clock limit;
 *    EIGHT_STREAM_IDLE_MS=0 turns the gap off and restores wall time only.
 */

export const DEFAULT_TURN_TIMEOUT_MS = 300_000;

/** Floor so a misconfigured env can never make attempts effectively instant. */
const MIN_TURN_TIMEOUT_MS = 1_000;

/** Which limit fired: the wall-clock ceiling, or a quiet gap with no output. */
export type TurnTimeoutKind = "ceiling" | "idle";

export class TurnTimeoutError extends Error {
	readonly timeoutMs: number;
	readonly kind: TurnTimeoutKind;
	constructor(timeoutMs: number, label?: string, kind: TurnTimeoutKind = "ceiling") {
		super(
			`Provider attempt timed out after ${timeoutMs}ms${label ? ` (${label})` : ""}`,
		);
		this.name = "TurnTimeoutError";
		this.timeoutMs = timeoutMs;
		this.kind = kind;
	}
}

/**
 * Resolve the per-attempt timeout in ms. Reads EIGHT_TURN_TIMEOUT_MS when set
 * to a positive finite number, otherwise falls back to DEFAULT_TURN_TIMEOUT_MS.
 * A value of 0 or a non-numeric value is treated as "unset" so the default
 * still applies (we never want an unbounded attempt by accident).
 */
export function resolveTurnTimeoutMs(
	env: Record<string, string | undefined> = process.env,
): number {
	const raw = env.EIGHT_TURN_TIMEOUT_MS;
	if (raw == null || raw === "") return DEFAULT_TURN_TIMEOUT_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TURN_TIMEOUT_MS;
	return Math.max(MIN_TURN_TIMEOUT_MS, Math.floor(parsed));
}

/**
 * Race a generate attempt against a wall-clock timeout.
 *
 * @param run     Executor that performs the actual generate. Receives nothing;
 *                it must already be wired to the shared abort signal so the
 *                onTimeout abort tears the underlying request down.
 * @param timeoutMs  Deadline in ms.
 * @param onTimeout  Called once when the deadline fires (typically aborts the
 *                   shared AbortController). Errors thrown here are swallowed so
 *                   the rejection path is deterministic.
 * @param label   Optional label (provider/model) for the error message.
 *
 * Resolves with the run() result if it settles first. Rejects with
 * TurnTimeoutError if the deadline fires first. The timer is always cleared.
 */
export async function withTurnTimeout<T>(
	run: () => Promise<T>,
	timeoutMs: number,
	onTimeout?: () => void,
	label?: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			try {
				onTimeout?.();
			} catch {
				// Aborting must never mask the timeout rejection.
			}
			reject(new TurnTimeoutError(timeoutMs, label));
		}, timeoutMs);
	});

	try {
		return await Promise.race([run(), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Default no-progress gap for a streamed text-tool step (#3657). It is the
 * old wall-clock default on purpose: anything that answered inside 5 minutes
 * before still does, a dead endpoint (socket accepted, no body) is still
 * caught at the same 5 minutes, and only the case that used to fail - a model
 * still writing at 5 minutes - now continues. The gap counts bytes, so
 * reasoning deltas keep a thinking model alive, but prompt prefill sends
 * nothing; 5 minutes also covers the worst-case prefill of a large context on
 * slow hardware without a special case.
 */
export const DEFAULT_STREAM_IDLE_MS = DEFAULT_TURN_TIMEOUT_MS;

/**
 * Stream idle gap (#3553, on by default since #3657) via EIGHT_STREAM_IDLE_MS.
 * The text-tool path streams its reply and judges a model step by silence
 * instead of total time: modelFetch re-arms this timer on every body chunk, so
 * a slow model that keeps writing is never cut off and a silent connection
 * fails after one quiet gap.
 *
 *  - unset / empty       -> DEFAULT_STREAM_IDLE_MS
 *  - "0" / "off" / < 0   -> null: gap off, wall time only (the pre-#3553 policy)
 *  - a positive number   -> that many ms, floor 1 s
 *  - anything else       -> DEFAULT_STREAM_IDLE_MS (a typo never turns it off)
 */
export function resolveStreamIdleMs(
	env: Record<string, string | undefined> = process.env,
): number | null {
	const raw = (env.EIGHT_STREAM_IDLE_MS ?? "").trim();
	if (raw === "") return DEFAULT_STREAM_IDLE_MS;
	if (raw.toLowerCase() === "off") return null;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_STREAM_IDLE_MS;
	if (parsed <= 0) return null;
	return Math.max(MIN_TURN_TIMEOUT_MS, Math.floor(parsed));
}

/**
 * Default wall-clock ceiling for one step when the stream idle gap is on: high
 * enough that a slow-but-writing local model finishes, still under the 30 min
 * session watchdog so that watchdog stays the outer bound.
 */
export const DEFAULT_STREAM_CEILING_MS = 20 * 60_000;

/**
 * Wall-clock limit for one streamed text-tool step. Gap off
 * (EIGHT_STREAM_IDLE_MS=0): exactly resolveTurnTimeoutMs(). Gap on:
 * EIGHT_TURN_TIMEOUT_MS when set (the explicit override), otherwise
 * DEFAULT_STREAM_CEILING_MS, since the idle gap is what catches a dead provider.
 */
export function resolveStepCeilingMs(
	env: Record<string, string | undefined> = process.env,
): number {
	if (resolveStreamIdleMs(env) === null || env.EIGHT_TURN_TIMEOUT_MS) {
		return resolveTurnTimeoutMs(env);
	}
	return DEFAULT_STREAM_CEILING_MS;
}
