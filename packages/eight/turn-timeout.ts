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
 *  - Native path (#3855): generate() is a whole multi-step tool loop, so it is
 *    judged by withProgressTimeout below (idle gap re-armed by step and tool
 *    progress, plus the resolveStepCeilingMs() outer budget). The flat bound
 *    that follows still guards single non-looping calls and the text-tool
 *    rounds:
 *
 *  - One wall-clock bound per attempt,
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

import { resolveRetrySettings } from "../settings/retry";
import { loadSettings } from "../settings/store";

export const DEFAULT_TURN_TIMEOUT_MS = 300_000;

/** Floor so a misconfigured env can never make attempts effectively instant. */
const MIN_TURN_TIMEOUT_MS = 1_000;

/** Which limit fired: the wall-clock ceiling, or a quiet gap with no output. */
export type TurnTimeoutKind = "ceiling" | "idle" | "request";

export class TurnTimeoutError extends Error {
	readonly timeoutMs: number;
	readonly kind: TurnTimeoutKind;
	constructor(timeoutMs: number, label?: string, kind: TurnTimeoutKind = "ceiling") {
		// #3855: say plainly which limit stopped the turn and which knob moves it.
		const why =
			kind === "request"
				? `: no reply for ${Math.round(timeoutMs / 1000)}s, request stopped (raise with EIGHT_REQUEST_TIMEOUT_SECONDS)`
				: kind === "idle"
					? `: no progress for ${Math.round(timeoutMs / 1000)}s (quiet gap; raise with EIGHT_STREAM_IDLE_MS)`
					: `: turn budget of ${Math.round(timeoutMs / 1000)}s reached (raise with EIGHT_TURN_TIMEOUT_MS)`;
		super(
			kind === "request"
				? `No reply from ${label ?? "the provider"} after ${Math.round(timeoutMs / 1000)}s; the request was stopped (raise with EIGHT_REQUEST_TIMEOUT_SECONDS).`
				: `Provider attempt timed out after ${timeoutMs}ms${label ? ` (${label})` : ""}${why}`,
		);
		this.name = "TurnTimeoutError";
		this.timeoutMs = timeoutMs;
		this.kind = kind;
	}
}

/**
 * Largest delay setTimeout honours (2^31-1 ms, about 24.8 days). Above it Bun
 * fires after 1 ms, so an env value meaning "never" would time out at once
 * (#3671). Both resolvers clamp to it.
 */
export const MAX_TIMER_MS = 2_147_483_647;

function clampTimerMs(ms: number): number {
	return Math.min(MAX_TIMER_MS, ms);
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
	return clampTimerMs(Math.max(MIN_TURN_TIMEOUT_MS, Math.floor(parsed)));
}

export const DEFAULT_STALL_SECONDS = 45;
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 300;
/** The stall notice repeats at this interval while the silence lasts (#4727). */
export const STALL_REPEAT_MS = 15_000;

function secondsEnv(raw: string | undefined, fallback: number): number {
	const n = Number((raw ?? "").trim());
	return raw && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** EIGHT_STALL_SECONDS: silence before the status line says it is still waiting (default 45). */
export function resolveStallMs(env: Record<string, string | undefined> = process.env): number {
	return clampTimerMs(secondsEnv(env.EIGHT_STALL_SECONDS, DEFAULT_STALL_SECONDS) * 1000);
}

/** EIGHT_REQUEST_TIMEOUT_SECONDS: silence after which the request is aborted (default 300). */
export function resolveRequestTimeoutMs(
	env: Record<string, string | undefined> = process.env,
): number {
	return clampTimerMs(
		secondsEnv(env.EIGHT_REQUEST_TIMEOUT_SECONDS, DEFAULT_REQUEST_TIMEOUT_SECONDS) * 1000,
	);
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
 * reasoning deltas keep a thinking model alive. Prompt prefill sends nothing
 * and can take far longer than 5 minutes for a long document (#3643), so the
 * wait for the first byte has its own budget: resolveFirstTokenMs.
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
	if (raw === "") {
		// Not set in the environment: settings.retry.httpIdleTimeoutMs (C4), validated, else the default.
		// Only for the real environment, so a test passing its own env object stays pure.
		const fromSettings =
			env === process.env
				? resolveRetrySettings(loadSettings().retry).httpIdleTimeoutMs
				: undefined;
		return fromSettings ?? DEFAULT_STREAM_IDLE_MS;
	}
	if (raw.toLowerCase() === "off") return null;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_STREAM_IDLE_MS;
	if (parsed <= 0) return null;
	return clampTimerMs(Math.max(MIN_TURN_TIMEOUT_MS, Math.floor(parsed)));
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

/**
 * Prompt prefill rate assumed when sizing the first-token budget, in tokens
 * per second. Deliberately slow: a large local model on a busy laptop with a
 * long KV cache, plus a cold model load. Overestimating only delays failover
 * for a long prompt on a dead endpoint; underestimating kills a healthy step
 * (#3643: 3 of 4 long-document runs died at 300 s in prefill).
 */
export const PREFILL_FLOOR_TOKENS_PER_S = 50;

/** Characters per token used for the prompt-size estimate. */
const CHARS_PER_TOKEN = 4;

/**
 * How long a streamed step may wait for its FIRST byte (#3643). Ollama sends
 * nothing, not even headers, until the whole prompt is prefilled, so the idle
 * gap must not count that time as silence. The budget is the idle gap plus
 * the prompt's estimated prefill time at PREFILL_FLOOR_TOKENS_PER_S, never
 * below the idle gap and never above the step ceiling. A short prompt gets
 * exactly the idle gap, so a dead endpoint still fails over in one gap.
 * EIGHT_FIRST_TOKEN_MS (positive ms, 1 s floor) replaces the estimate; any
 * other value falls back to it.
 */
export function resolveFirstTokenMs(args: {
	idleMs: number;
	promptChars: number;
	ceilingMs: number;
	env?: Record<string, string | undefined>;
}): number {
	const env = args.env ?? process.env;
	const raw = (env.EIGHT_FIRST_TOKEN_MS ?? "").trim();
	const parsed = raw === "" ? Number.NaN : Number(raw);
	if (Number.isFinite(parsed) && parsed > 0) {
		return clampTimerMs(Math.max(MIN_TURN_TIMEOUT_MS, Math.floor(parsed)));
	}
	const tokens = Math.max(0, args.promptChars) / CHARS_PER_TOKEN;
	const prefillMs = Math.ceil((tokens / PREFILL_FLOOR_TOKENS_PER_S) * 1000);
	return clampTimerMs(Math.max(args.idleMs, Math.min(args.ceilingMs, args.idleMs + prefillMs)));
}

/**
 * Progress signal for a multi-step native attempt (#3855).
 *
 * One native generate() is a whole tool loop: many model calls and tool runs
 * inside a single awaited promise. A flat wall clock of DEFAULT_TURN_TIMEOUT_MS
 * around it killed healthy cloud turns that kept producing (a media run killed
 * 9 s after its last output). The loop reports progress here instead:
 *
 *  - touch(): a step finished or a tool returned; re-arm the idle gap.
 *  - hold()/release(): a tool is running. Its own timeout owns that time, so
 *    the idle gap is suspended while any tool is in flight and re-armed fresh
 *    when the last one returns. The ceiling never pauses.
 */
export class ProgressWatch {
	private held = 0;
	private onTouch: (() => void) | null = null;
	bind(rearm: () => void): void {
		this.onTouch = rearm;
	}
	touch(): void {
		if (this.held === 0) this.onTouch?.();
	}
	hold(): void {
		this.held++;
		this.onTouch?.();
	}
	release(): void {
		this.held = Math.max(0, this.held - 1);
		this.onTouch?.();
	}
	/**
	 * A model step finished, so every tool of that step has returned. Zero the
	 * hold count (a tool that threw without onToolCallFinish must not leave the
	 * idle gap suspended for the rest of the attempt) and re-arm the gap.
	 */
	stepDone(): void {
		this.held = 0;
		this.onTouch?.();
	}
	get isHeld(): boolean {
		return this.held > 0;
	}
}

export interface ProgressTimeoutOptions {
	/** Max quiet gap between progress signals; null turns the gap off. */
	idleMs: number | null;
	/** Hard wall-clock bound for the whole attempt (the outer turn budget). */
	ceilingMs: number;
	onTimeout?: () => void;
	label?: string;
	/** Human name (provider/model) used in the error message; label stays for logs. */
	displayLabel?: string;
	/** Hard no-reply bound (#4727): the gap used is min(idleMs, requestMs), kind "request" when it wins. */
	requestMs?: number;
	/** Silence before onStall first fires, then every STALL_REPEAT_MS; null seconds = reply arrived. */
	stallMs?: number;
	onStall?: (silentSeconds: number | null) => void;
	/** Clock seams for tests. */
	now?: () => number;
}

/**
 * Race a multi-step attempt against an idle gap (re-armed by progress) and a
 * wall-clock ceiling. A silent provider dies after one gap; a loop that keeps
 * finishing steps or tools lives until the ceiling. Fail-closed on both.
 */
export async function withProgressTimeout<T>(
	run: (watch: ProgressWatch) => Promise<T>,
	opts: ProgressTimeoutOptions,
): Promise<T> {
	const watch = new ProgressWatch();
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let ceilingTimer: ReturnType<typeof setTimeout> | null = null;
	let rejectFn: (e: Error) => void = () => {};
	const fire = (ms: number, kind: TurnTimeoutKind) => {
		try {
			opts.onTimeout?.();
		} catch {
			// Aborting must never mask the timeout rejection.
		}
		if (stallShown) {
			stallShown = false;
			try {
				opts.onStall?.(null);
			} catch {
				// display only
			}
		}
		rejectFn(new TurnTimeoutError(ms, opts.displayLabel ?? opts.label, kind));
	};
	let closed = false;
	let stallTimer: ReturnType<typeof setTimeout> | null = null;
	let lastProgress = (opts.now ?? Date.now)();
	let stallShown = false;
	const armStall = (delay: number) => {
		stallTimer = setTimeout(() => {
			stallShown = true;
			try {
				opts.onStall?.(Math.round(((opts.now ?? Date.now)() - lastProgress) / 1000));
			} catch {
				// A display failure must never change the timeout outcome.
			}
			armStall(STALL_REPEAT_MS);
		}, delay);
	};
	const rearm = () => {
		// A late progress signal after settle must never re-arm a zombie timer
		// that would abort the NEXT turn's shared controller.
		if (closed) return;
		if (idleTimer) clearTimeout(idleTimer);
		if (stallTimer) clearTimeout(stallTimer);
		idleTimer = stallTimer = null;
		lastProgress = (opts.now ?? Date.now)();
		if (stallShown) {
			stallShown = false;
			try {
				opts.onStall?.(null);
			} catch {
				// display only
			}
		}
		if (watch.isHeld) return;
		const req = opts.requestMs ?? null;
		const gap =
			opts.idleMs === null ? req : req === null ? opts.idleMs : Math.min(opts.idleMs, req);
		if (opts.stallMs && opts.onStall && (gap === null || opts.stallMs < gap))
			armStall(opts.stallMs);
		if (gap === null) return;
		const kind: TurnTimeoutKind = req !== null && req === gap ? "request" : "idle";
		idleTimer = setTimeout(() => fire(gap, kind), gap);
	};
	const timeout = new Promise<never>((_, reject) => {
		rejectFn = reject;
	});
	watch.bind(rearm);
	ceilingTimer = setTimeout(() => fire(opts.ceilingMs, "ceiling"), opts.ceilingMs);
	rearm();
	try {
		return await Promise.race([run(watch), timeout]);
	} finally {
		closed = true;
		if (stallShown) {
			stallShown = false;
			try {
				opts.onStall?.(null);
			} catch {
				// display only
			}
		}
		if (idleTimer) clearTimeout(idleTimer);
		if (stallTimer) clearTimeout(stallTimer);
		if (ceilingTimer) clearTimeout(ceilingTimer);
	}
}
