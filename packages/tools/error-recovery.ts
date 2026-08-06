/**
 * error-recovery.ts
 *
 * Composable error recovery strategies: retry, fallback, ignore, log, rethrow.
 * Use withRecovery(fn, strategy) to wrap any async function.
 * Use chainStrategies(s1, s2) to compose strategies sequentially.
 */

export type BackoffKind = "fixed" | "exponential" | "linear";

export interface RetryOptions {
	/** Total attempts including the first call (default 3). */
	attempts?: number;
	/** Base delay before each retry in milliseconds (default 0 = no wait). */
	delayMs?: number;
	/** Delay growth across retries (default "fixed"). */
	backoff?: BackoffKind;
	/** Upper bound on any single computed delay, applied before jitter. */
	maxDelayMs?: number;
	/**
	 * When true, each delay is randomized within [delay / 2, delay]
	 * (equal jitter). Bounded so a delay never exceeds the computed
	 * backoff and never drops below half of it.
	 */
	jitter?: boolean;
	/** Random source for jitter, returns [0, 1). Injectable for tests (default Math.random). */
	random?: () => number;
	/**
	 * Predicate deciding whether an error is retryable. Returning false
	 * short-circuits: the error is rethrown immediately with no further
	 * attempts and no onRetry call. Default: retry every error.
	 */
	retryIf?: (err: unknown) => boolean;
	/** Called before each retry with the 1-based retry number and the error that caused it. */
	onRetry?: (attempt: number, err: unknown) => void;
	/** Sleep implementation. Injectable for tests (default real setTimeout). */
	sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Compute the delay before retry number `attempt` (1-based).
 *
 * - fixed: delayMs
 * - exponential: delayMs * 2^(attempt - 1)
 * - linear: delayMs * attempt
 *
 * The result is capped at maxDelayMs (when set), then jittered into
 * [delay / 2, delay] when jitter is enabled.
 */
export function backoffDelay(
	attempt: number,
	options: Pick<RetryOptions, "delayMs" | "backoff" | "maxDelayMs" | "jitter" | "random"> = {},
): number {
	const {
		delayMs = 0,
		backoff = "fixed",
		maxDelayMs,
		jitter = false,
		random = Math.random,
	} = options;
	if (delayMs <= 0) return 0;
	const n = Math.max(1, attempt);
	let delay: number;
	switch (backoff) {
		case "exponential":
			delay = delayMs * 2 ** (n - 1);
			break;
		case "linear":
			delay = delayMs * n;
			break;
		default:
			delay = delayMs;
	}
	if (maxDelayMs !== undefined) delay = Math.min(delay, maxDelayMs);
	if (jitter) {
		const half = delay / 2;
		delay = half + random() * half;
	}
	return delay;
}

/**
 * Plain retry convenience: call `fn` until it succeeds or attempts run out.
 * The first call counts as attempt 1. Throws the last error on exhaustion
 * or immediately when retryIf(error) returns false.
 */
export async function retryAsync<T>(
	fn: (attempt: number) => T | Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	const attempts = Math.max(1, options.attempts ?? 3);
	const sleep = options.sleep ?? defaultSleep;
	let lastErr: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await fn(attempt);
		} catch (err) {
			lastErr = err;
			if (attempt >= attempts) break;
			if (options.retryIf && !options.retryIf(err)) break;
			if (options.onRetry) options.onRetry(attempt, err);
			const wait = backoffDelay(attempt, options);
			if (wait > 0) await sleep(wait);
		}
	}
	throw lastErr;
}

export type RecoveryResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface RecoveryStrategy<T = unknown> {
	handle(err: unknown, fn: () => Promise<T>): Promise<T>;
}

/** Retry the operation up to `attempts` times with optional delay, backoff, jitter, and retryIf. */
export function retry<T>(options: RetryOptions = {}): RecoveryStrategy<T> {
	const { attempts = 3, onRetry, retryIf } = options;
	const sleep = options.sleep ?? defaultSleep;
	return {
		async handle(err, fn) {
			let lastErr = err;
			for (let i = 1; i < attempts; i++) {
				if (retryIf && !retryIf(lastErr)) break;
				if (onRetry) onRetry(i, lastErr);
				const wait = backoffDelay(i, options);
				if (wait > 0) await sleep(wait);
				try {
					return await fn();
				} catch (e) {
					lastErr = e;
				}
			}
			throw lastErr;
		},
	};
}

/** On error, call `fallbackFn` and return its result instead. */
export function fallback<T>(fallbackFn: (err: unknown) => T | Promise<T>): RecoveryStrategy<T> {
	return {
		async handle(err) {
			return fallbackFn(err);
		},
	};
}

/** Silently ignore the error and return undefined (cast to T). */
export function ignore<T>(): RecoveryStrategy<T | undefined> {
	return {
		async handle() {
			return undefined;
		},
	};
}

/** Log the error then rethrow it. */
export function log<T>(
	logger: (err: unknown) => void = (e) => console.error("[error-recovery]", e),
): RecoveryStrategy<T> {
	return {
		async handle(err) {
			logger(err);
			throw err;
		},
	};
}

/** Always rethrow the error (default / no-op recovery). */
export function rethrow<T>(): RecoveryStrategy<T> {
	return {
		async handle(err) {
			throw err;
		},
	};
}

/**
 * Wrap an async function with a recovery strategy.
 * On success the value is returned directly.
 * On error the strategy's handle() is invoked.
 */
export async function withRecovery<T>(
	fn: () => Promise<T>,
	strategy: RecoveryStrategy<T>,
): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		return strategy.handle(err, fn);
	}
}

/**
 * Compose two strategies: if s1's handle throws, s2's handle is tried.
 */
export function chainStrategies<T>(
	s1: RecoveryStrategy<T>,
	s2: RecoveryStrategy<T>,
): RecoveryStrategy<T> {
	return {
		async handle(err, fn) {
			try {
				return await s1.handle(err, fn);
			} catch (err2) {
				return s2.handle(err2, fn);
			}
		},
	};
}
