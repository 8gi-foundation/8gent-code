/**
 * Exponential backoff retry utility for 8gent tool calls.
 *
 * Configurable max attempts, base/max delay, jitter, and abort conditions.
 * Designed for provider calls, browser fetches, and any flaky async work.
 */

export interface RetryOptions<T = unknown> {
  /** Maximum number of attempts (default: 3). */
  maxAttempts?: number;
  /** Initial delay in ms before first retry (default: 500). */
  baseDelay?: number;
  /** Upper bound on delay in ms (default: 30_000). */
  maxDelay?: number;
  /** Multiplier applied each retry (default: 2). */
  backoffFactor?: number;
  /** Add random jitter up to this fraction of the delay, 0-1 (default: 0.25). */
  jitter?: number;
  /** Return true to abort early instead of retrying. */
  shouldAbort?: (error: unknown, attempt: number) => boolean;
  /** Called before each retry - useful for logging. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** AbortSignal - cancels the wait between retries. */
  signal?: AbortSignal;
}

export class RetryAbortedError extends Error {
  public readonly lastError: unknown;
  public readonly attempt: number;

  constructor(message: string, lastError: unknown, attempt: number) {
    super(message);
    this.name = "RetryAbortedError";
    this.lastError = lastError;
    this.attempt = attempt;
  }
}

export class RetriesExhaustedError extends Error {
  public readonly lastError: unknown;
  public readonly attempts: number;

  constructor(lastError: unknown, attempts: number) {
    super(`All ${attempts} retry attempts exhausted`);
    this.name = "RetriesExhaustedError";
    this.lastError = lastError;
    this.attempts = attempts;
  }
}

function computeDelay(
  attempt: number,
  baseDelay: number,
  backoffFactor: number,
  maxDelay: number,
  jitter: number,
): number {
  const exponential = baseDelay * backoffFactor ** (attempt - 1);
  const clamped = Math.min(exponential, maxDelay);
  const jitterAmount = clamped * jitter * Math.random();
  return Math.round(clamped + jitterAmount);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions<T> = {}): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelay = 500,
    maxDelay = 30_000,
    backoffFactor = 2,
    jitter = 0.25,
    shouldAbort,
    onRetry,
    signal,
  } = opts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (shouldAbort?.(error, attempt)) {
        throw new RetryAbortedError("Retry aborted by shouldAbort condition", error, attempt);
      }
      if (attempt === maxAttempts) {
        throw new RetriesExhaustedError(error, maxAttempts);
      }
      const delayMs = computeDelay(attempt, baseDelay, backoffFactor, maxDelay, jitter);
      onRetry?.(error, attempt, delayMs);
      await sleep(delayMs, signal);
    }
  }

  // Unreachable, but satisfies TypeScript.
  throw new Error("retry: unreachable");
}
