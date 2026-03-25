/**
 * promise-timeout.ts
 * Timeout, retry, delay, race, all with concurrency, and map utilities
 * for async flow control. Zero dependencies.
 */

export class TimeoutError extends Error {
  constructor(message: string, public readonly ms: number) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class RetryError extends Error {
  constructor(message: string, public readonly attempts: number, public readonly cause: unknown) {
    super(message);
    this.name = "RetryError";
  }
}

/**
 * Wrap a promise with a hard timeout.
 * Rejects with TimeoutError if the promise does not settle within `ms`.
 */
export function pTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message?: string
): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(message ?? `Promise timed out after ${ms}ms`, ms));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

export interface RetryOptions {
  /** Max number of attempts (default 3) */
  attempts?: number;
  /** Base delay between attempts in ms (default 200) */
  delay?: number;
  /** Exponential backoff factor (default 2) */
  factor?: number;
  /** Max delay cap in ms (default 5000) */
  maxDelay?: number;
  /** Optional predicate — return false to stop retrying early */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

/**
 * Retry an async function with exponential backoff.
 * Throws RetryError if all attempts are exhausted.
 */
export async function pRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { attempts = 3, delay = 200, factor = 2, maxDelay = 5000, shouldRetry } = options;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (shouldRetry && !shouldRetry(err, i)) break;
      if (i < attempts) {
        const wait = Math.min(delay * Math.pow(factor, i - 1), maxDelay);
        await pDelay(wait);
      }
    }
  }
  throw new RetryError(
    `Failed after ${attempts} attempt(s): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    attempts,
    lastErr
  );
}

/**
 * Resolve after `ms` milliseconds.
 * Optionally pass a value to resolve with.
 */
export function pDelay<T = void>(ms: number, value?: T): Promise<T> {
  return new Promise<T>((resolve) => setTimeout(() => resolve(value as T), ms));
}

/**
 * Race N promises, resolving once `count` of them have fulfilled.
 * Rejects if fewer than `count` promises fulfill (rest rejected).
 * Default count is 1 (first to win).
 */
export function pRace<T>(promises: Promise<T>[], count = 1): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const results: T[] = [];
    let settled = 0;
    let rejected = 0;
    const total = promises.length;
    if (total === 0 || count > total) {
      reject(new Error(`pRace: cannot fulfill ${count} from ${total} promises`));
      return;
    }
    for (const p of promises) {
      Promise.resolve(p).then(
        (val) => {
          if (results.length < count) {
            results.push(val);
            if (results.length === count) resolve(results);
          }
        },
        () => {
          rejected++;
          settled++;
          if (total - rejected < count - results.length) {
            reject(new Error(`pRace: not enough promises fulfilled (${results.length}/${count})`));
          }
        }
      );
    }
  });
}

/**
 * Run all promises with bounded concurrency.
 * Resolves to an array of all settled results in input order.
 */
export function pAll<T>(promises: Promise<T>[], concurrency = Infinity): Promise<T[]> {
  return pMap(promises, (p) => p, { concurrency });
}

export interface MapOptions {
  /** Max concurrent operations (default Infinity) */
  concurrency?: number;
  /** Stop on first error rather than collecting all (default false) */
  stopOnError?: boolean;
}

/**
 * Map over items with bounded concurrency.
 * Preserves input order in output array.
 */
export async function pMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  options: MapOptions = {}
): Promise<R[]> {
  const { concurrency = Infinity, stopOnError = false } = options;
  const results: R[] = new Array(items.length);
  const limit = Math.max(1, concurrency === Infinity ? items.length || 1 : concurrency);
  let index = 0;
  let running = 0;
  let hasError = false;
  let errorVal: unknown;

  return new Promise<R[]>((resolve, reject) => {
    if (items.length === 0) { resolve([]); return; }

    function next() {
      if (hasError && stopOnError) return;
      while (running < limit && index < items.length) {
        const i = index++;
        running++;
        fn(items[i], i).then(
          (val) => {
            results[i] = val;
            running--;
            if (running === 0 && index >= items.length) {
              if (hasError && !stopOnError) reject(errorVal);
              else resolve(results);
            } else {
              next();
            }
          },
          (err) => {
            running--;
            hasError = true;
            errorVal = err;
            if (stopOnError) { reject(err); return; }
            if (running === 0 && index >= items.length) reject(err);
            else next();
          }
        );
      }
    }

    next();
  });
}
