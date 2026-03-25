/**
 * Lazy initialization with memoization for expensive computations.
 *
 * Provides sync and async lazy values, reset support, and lazy object records
 * with cache hit/miss statistics.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LazyStats {
  hits: number;
  misses: number;
  computed: boolean;
}

export interface Lazy<T> {
  /** Access the lazily-computed value (computes on first access). */
  get value(): T;
  /** True if the value has been computed at least once. */
  readonly computed: boolean;
  /** Discard the cached value - next access recomputes. */
  reset(): void;
  /** Cache statistics. */
  stats(): LazyStats;
}

export interface AsyncLazy<T> {
  /** Access the lazily-computed value (computes on first access). */
  get(): Promise<T>;
  /** True if the value has been computed at least once. */
  readonly computed: boolean;
  /** Discard the cached value - next access recomputes. */
  reset(): void;
  /** Cache statistics. */
  stats(): LazyStats;
}

export type LazyRecord<T extends Record<string, unknown>> = {
  readonly [K in keyof T]: T[K];
} & {
  /** Reset one or all keys. Omit key to reset everything. */
  $reset(key?: keyof T): void;
  /** Stats per key or aggregated across all keys. */
  $stats(key?: keyof T): LazyStats;
};

// ---------------------------------------------------------------------------
// Sync lazy
// ---------------------------------------------------------------------------

/**
 * Create a lazy value that computes once on first access.
 *
 * @example
 * const config = lazy(() => JSON.parse(fs.readFileSync('config.json', 'utf8')));
 * console.log(config.value); // reads file once
 * console.log(config.value); // returns cached value
 */
export function lazy<T>(factory: () => T): Lazy<T> {
  let cached: T | undefined;
  let _computed = false;
  let hits = 0;
  let misses = 0;

  return {
    get value(): T {
      if (_computed) {
        hits++;
        return cached as T;
      }
      misses++;
      cached = factory();
      _computed = true;
      return cached;
    },
    get computed() {
      return _computed;
    },
    reset() {
      cached = undefined;
      _computed = false;
    },
    stats(): LazyStats {
      return { hits, misses, computed: _computed };
    },
  };
}

// ---------------------------------------------------------------------------
// Async lazy
// ---------------------------------------------------------------------------

/**
 * Create an async lazy value that computes once on first access.
 * Concurrent calls during the first computation share the same promise.
 *
 * @example
 * const db = asyncLazy(() => openDatabase());
 * const conn = await db.get(); // connects once
 */
export function asyncLazy<T>(factory: () => Promise<T>): AsyncLazy<T> {
  let cached: T | undefined;
  let _computed = false;
  let inflight: Promise<T> | undefined;
  let hits = 0;
  let misses = 0;

  return {
    async get(): Promise<T> {
      if (_computed) {
        hits++;
        return cached as T;
      }
      if (inflight) {
        hits++;
        return inflight;
      }
      misses++;
      inflight = factory().then((v) => {
        cached = v;
        _computed = true;
        inflight = undefined;
        return v;
      });
      return inflight;
    },
    get computed() {
      return _computed;
    },
    reset() {
      cached = undefined;
      _computed = false;
      inflight = undefined;
    },
    stats(): LazyStats {
      return { hits, misses, computed: _computed };
    },
  };
}

// ---------------------------------------------------------------------------
// Lazy record
// ---------------------------------------------------------------------------

/**
 * Create an object where each property is computed lazily from a factory map.
 *
 * @example
 * const services = lazyRecord({
 *   db: () => new Database(),
 *   cache: () => new Cache(),
 * });
 * services.db;    // initializes DB only
 * services.cache; // initializes cache only
 */
export function lazyRecord<T extends Record<string, unknown>>(
  factories: { [K in keyof T]: () => T[K] }
): LazyRecord<T> {
  const instances: Partial<T> = {};
  const statsMap: Record<string, LazyStats> = {};

  for (const key of Object.keys(factories) as (keyof T)[]) {
    statsMap[key as string] = { hits: 0, misses: 0, computed: false };
  }

  const proxy = new Proxy({} as LazyRecord<T>, {
    get(_target, prop: string | symbol) {
      if (prop === "$reset") {
        return (key?: keyof T) => {
          if (key !== undefined) {
            delete instances[key];
            statsMap[key as string] = { hits: 0, misses: 0, computed: false };
          } else {
            for (const k of Object.keys(factories)) {
              delete instances[k as keyof T];
              statsMap[k] = { hits: 0, misses: 0, computed: false };
            }
          }
        };
      }
      if (prop === "$stats") {
        return (key?: keyof T): LazyStats => {
          if (key !== undefined) return statsMap[key as string];
          const all = Object.values(statsMap) as LazyStats[];
          return all.reduce(
            (acc, s) => ({
              hits: acc.hits + s.hits,
              misses: acc.misses + s.misses,
              computed: acc.computed || s.computed,
            }),
            { hits: 0, misses: 0, computed: false }
          );
        };
      }
      if (!(prop in factories)) return undefined;
      const k = prop as keyof T;
      if (k in instances) {
        statsMap[prop].hits++;
        return instances[k];
      }
      statsMap[prop].misses++;
      instances[k] = (factories[k] as () => T[keyof T])();
      statsMap[prop].computed = true;
      return instances[k];
    },
  });

  return proxy;
}
