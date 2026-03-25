/**
 * retry-with-fallback
 *
 * Tries a primary operation with configurable retries.
 * If all primary attempts fail, walks through fallback
 * alternatives in order, each with its own retry budget.
 */

export interface RetryOptions {
  /** Max attempts per level (primary + each fallback). Default: 3 */
  retries?: number;
  /** Base delay in ms between attempts (exponential backoff). Default: 200 */
  baseDelayMs?: number;
  /** Max delay cap in ms. Default: 5000 */
  maxDelayMs?: number;
  /** Called on each failed attempt: (error, attempt, level) => void */
  onRetry?: (error: unknown, attempt: number, level: number) => void;
}

export interface FallbackResult<T> {
  value: T;
  /** 0 = primary succeeded, 1+ = index of fallback that succeeded */
  level: number;
  /** Total attempts made across all levels */
  totalAttempts: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function backoff(attempt: number, base: number, max: number): number {
  return Math.min(base * 2 ** attempt + Math.random() * base, max);
}

/**
 * Attempt a single operation with retry logic.
 * Returns the result or throws the last error.
 */
async function retryOnce<T>(
  fn: () => Promise<T>,
  retries: number,
  baseDelayMs: number,
  maxDelayMs: number,
  level: number,
  attemptOffset: number,
  onRetry?: RetryOptions["onRetry"]
): Promise<{ value: T; attempts: number }> {
  let lastError: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const value = await fn();
      return { value, attempts: i + 1 };
    } catch (err) {
      lastError = err;
      onRetry?.(err, attemptOffset + i + 1, level);
      if (i < retries - 1) {
        await sleep(backoff(i, baseDelayMs, maxDelayMs));
      }
    }
  }
  throw lastError;
}

/**
 * Try `primary` up to `options.retries` times. If all attempts fail,
 * walk `fallbacks` in order, each with their own retry budget.
 *
 * Throws an AggregateError if every level exhausts its attempts.
 */
export async function withFallback<T>(
  primary: () => Promise<T>,
  fallbacks: Array<() => Promise<T>>,
  options: RetryOptions = {}
): Promise<FallbackResult<T>> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 200;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const { onRetry } = options;

  const errors: unknown[] = [];
  let totalAttempts = 0;

  const levels = [primary, ...fallbacks];

  for (let level = 0; level < levels.length; level++) {
    try {
      const { value, attempts } = await retryOnce(
        levels[level],
        retries,
        baseDelayMs,
        maxDelayMs,
        level,
        totalAttempts,
        onRetry
      );
      totalAttempts += attempts;
      return { value, level, totalAttempts };
    } catch (err) {
      errors.push(err);
      totalAttempts += retries;
    }
  }

  throw new AggregateError(
    errors,
    `All ${levels.length} level(s) failed after ${totalAttempts} total attempts.`
  );
}

/**
 * Builder pattern for constructing a fallback chain.
 *
 * @example
 * const result = await new FallbackChain(() => fetchFromPrimary())
 *   .fallback(() => fetchFromReplica())
 *   .fallback(() => fetchFromCache())
 *   .options({ retries: 2, baseDelayMs: 100 })
 *   .run();
 */
export class FallbackChain<T> {
  private readonly _primary: () => Promise<T>;
  private readonly _fallbacks: Array<() => Promise<T>> = [];
  private _options: RetryOptions = {};

  constructor(primary: () => Promise<T>) {
    this._primary = primary;
  }

  fallback(fn: () => Promise<T>): this {
    this._fallbacks.push(fn);
    return this;
  }

  options(opts: RetryOptions): this {
    this._options = { ...this._options, ...opts };
    return this;
  }

  run(): Promise<FallbackResult<T>> {
    return withFallback(this._primary, this._fallbacks, this._options);
  }
}
