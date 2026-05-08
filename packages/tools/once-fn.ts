/**
 * once-fn - single-execution and memoization wrappers
 *
 * once(fn)          - executes fn exactly once, returns cached result on all subsequent calls
 * memoize(fn)       - caches results keyed by serialized arguments
 * memoizeAsync(fn)  - same as memoize but for async functions, deduplicates in-flight calls
 * memoizeWithTTL    - cached results expire after a given millisecond window
 * clearMemo         - evicts the cache attached to a memoized function
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AnyFn = (...args: any[]) => any;

interface Memoized<T extends AnyFn> {
  (...args: Parameters<T>): ReturnType<T>;
  /** Evict all cached entries. */
  _cache: Map<string, ReturnType<T>>;
}

interface MemoizedAsync<T extends (...args: any[]) => Promise<any>> {
  (...args: Parameters<T>): ReturnType<T>;
  _cache: Map<string, Awaited<ReturnType<T>>>;
  _inflight: Map<string, ReturnType<T>>;
}

interface MemoizedTTL<T extends AnyFn> {
  (...args: Parameters<T>): ReturnType<T>;
  _cache: Map<string, { value: ReturnType<T>; expiresAt: number }>;
}

// ---------------------------------------------------------------------------
// once
// ---------------------------------------------------------------------------

/**
 * Returns a wrapper that calls fn only on the first invocation.
 * All subsequent calls return the result of that first call without re-executing fn.
 *
 * @example
 * const init = once(() => expensiveSetup());
 * init(); // runs expensiveSetup
 * init(); // returns cached result, no second call
 */
export function once<T extends AnyFn>(fn: T): (...args: Parameters<T>) => ReturnType<T> {
  let called = false;
  let result: ReturnType<T>;
  return function (...args: Parameters<T>): ReturnType<T> {
    if (!called) {
      called = true;
      result = fn(...args);
    }
    return result;
  };
}

// ---------------------------------------------------------------------------
// memoize
// ---------------------------------------------------------------------------

/**
 * Caches the return value of fn keyed by JSON-serialized arguments.
 * Suitable for pure synchronous functions.
 *
 * @example
 * const fib = memoize((n: number): number => n <= 1 ? n : fib(n - 1) + fib(n - 2));
 */
export function memoize<T extends AnyFn>(fn: T): Memoized<T> {
  const cache = new Map<string, ReturnType<T>>();

  const wrapped = function (...args: Parameters<T>): ReturnType<T> {
    const key = JSON.stringify(args);
    if (cache.has(key)) return cache.get(key) as ReturnType<T>;
    const value = fn(...args) as ReturnType<T>;
    cache.set(key, value);
    return value;
  } as Memoized<T>;

  wrapped._cache = cache;
  return wrapped;
}

// ---------------------------------------------------------------------------
// memoizeAsync
// ---------------------------------------------------------------------------

/**
 * Caches resolved promise values and deduplicates concurrent in-flight calls
 * with the same arguments, so a slow async fn is never called twice in parallel
 * for the same input.
 *
 * @example
 * const fetchUser = memoizeAsync(async (id: string) => db.getUser(id));
 */
export function memoizeAsync<T extends (...args: any[]) => Promise<any>>(fn: T): MemoizedAsync<T> {
  const cache = new Map<string, Awaited<ReturnType<T>>>();
  const inflight = new Map<string, ReturnType<T>>();

  const wrapped = function (...args: Parameters<T>): ReturnType<T> {
    const key = JSON.stringify(args);
    if (cache.has(key)) return Promise.resolve(cache.get(key)) as ReturnType<T>;
    if (inflight.has(key)) return inflight.get(key) as ReturnType<T>;
    const promise = (fn(...args) as ReturnType<T>).then((value: Awaited<ReturnType<T>>) => {
      cache.set(key, value);
      inflight.delete(key);
      return value;
    });
    inflight.set(key, promise);
    return promise;
  } as MemoizedAsync<T>;

  wrapped._cache = cache;
  wrapped._inflight = inflight;
  return wrapped;
}

// ---------------------------------------------------------------------------
// memoizeWithTTL
// ---------------------------------------------------------------------------

/**
 * Like memoize but each cache entry expires after `ttlMs` milliseconds.
 * Expired entries are evicted on the next access for that key.
 *
 * @param fn   - pure function to memoize
 * @param ttlMs - time-to-live in milliseconds
 *
 * @example
 * const cachedPrice = memoizeWithTTL(fetchPrice, 60_000); // 1-minute cache
 */
export function memoizeWithTTL<T extends AnyFn>(fn: T, ttlMs: number): MemoizedTTL<T> {
  const cache = new Map<string, { value: ReturnType<T>; expiresAt: number }>();

  const wrapped = function (...args: Parameters<T>): ReturnType<T> {
    const key = JSON.stringify(args);
    const now = Date.now();
    const entry = cache.get(key);
    if (entry && now < entry.expiresAt) return entry.value;
    const value = fn(...args) as ReturnType<T>;
    cache.set(key, { value, expiresAt: now + ttlMs });
    return value;
  } as MemoizedTTL<T>;

  wrapped._cache = cache;
  return wrapped;
}

// ---------------------------------------------------------------------------
// clearMemo
// ---------------------------------------------------------------------------

/**
 * Evicts all cached entries from a memoized function returned by
 * memoize, memoizeAsync, or memoizeWithTTL.
 *
 * @example
 * const fn = memoize(expensiveFn);
 * fn(1); // cached
 * clearMemo(fn);
 * fn(1); // re-executes
 */
export function clearMemo(
  memoized: Memoized<AnyFn> | MemoizedAsync<AnyFn> | MemoizedTTL<AnyFn>
): void {
  memoized._cache.clear();
  if ("_inflight" in memoized) {
    (memoized as MemoizedAsync<AnyFn>)._inflight.clear();
  }
}
