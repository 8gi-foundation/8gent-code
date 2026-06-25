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
 * Default: 120s per attempt. Override with EIGHT_TURN_TIMEOUT_MS.
 */

export const DEFAULT_TURN_TIMEOUT_MS = 120_000;

/** Floor so a misconfigured env can never make attempts effectively instant. */
const MIN_TURN_TIMEOUT_MS = 1_000;

export class TurnTimeoutError extends Error {
	readonly timeoutMs: number;
	constructor(timeoutMs: number, label?: string) {
		super(
			`Provider attempt timed out after ${timeoutMs}ms${label ? ` (${label})` : ""}`,
		);
		this.name = "TurnTimeoutError";
		this.timeoutMs = timeoutMs;
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
