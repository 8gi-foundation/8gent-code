/**
 * error-recovery.ts
 *
 * Composable error recovery strategies: retry, fallback, ignore, log, rethrow.
 * Use withRecovery(fn, strategy) to wrap any async function.
 * Use chainStrategies(s1, s2) to compose strategies sequentially.
 */

export interface RetryOptions {
  attempts?: number;
  delayMs?: number;
  backoff?: "fixed" | "exponential";
  onRetry?: (attempt: number, err: unknown) => void;
}

export type RecoveryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export interface RecoveryStrategy<T = unknown> {
  handle(err: unknown, fn: () => Promise<T>): Promise<T>;
}

/** Retry the operation up to `attempts` times with optional delay and backoff. */
export function retry<T>(options: RetryOptions = {}): RecoveryStrategy<T> {
  const { attempts = 3, delayMs = 0, backoff = "fixed", onRetry } = options;
  return {
    async handle(err, fn) {
      let lastErr = err;
      for (let i = 1; i < attempts; i++) {
        if (onRetry) onRetry(i, lastErr);
        if (delayMs > 0) {
          const wait = backoff === "exponential" ? delayMs * 2 ** (i - 1) : delayMs;
          await new Promise((r) => setTimeout(r, wait));
        }
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
  logger: (err: unknown) => void = (e) => console.error("[error-recovery]", e)
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
  strategy: RecoveryStrategy<T>
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
  s2: RecoveryStrategy<T>
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
