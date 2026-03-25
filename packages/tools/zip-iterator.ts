/**
 * zip-iterator.ts
 * Python-style zip utilities for parallel iteration over multiple iterables.
 *
 * Functions:
 *   zip(...iterables)         - yields tuples, stops at shortest
 *   zipLongest(...iterables)  - yields tuples, pads shorter with fillValue
 *   unzip(zipped)             - separates zipped array into per-iterable arrays
 *   zipWith(fn, ...iterables) - maps a function while zipping, stops at shortest
 */

type AnyIterable<T> = Iterable<T> | ArrayLike<T>;

/** Converts any iterable or array-like to a plain array. */
function toArray<T>(src: AnyIterable<T>): T[] {
  if (Array.isArray(src)) return src;
  if (typeof (src as Iterable<T>)[Symbol.iterator] === "function") {
    return Array.from(src as Iterable<T>);
  }
  // ArrayLike fallback
  const al = src as ArrayLike<T>;
  const out: T[] = [];
  for (let i = 0; i < al.length; i++) out.push(al[i]);
  return out;
}

/**
 * Zips multiple iterables together, yielding tuples of one item per iterable.
 * Stops when the shortest iterable is exhausted.
 *
 * @example
 * [...zip([1,2,3], ['a','b','c'])] // [[1,'a'],[2,'b'],[3,'c']]
 */
export function* zip<T extends unknown[]>(
  ...iterables: { [K in keyof T]: AnyIterable<T[K]> }
): Generator<T> {
  if (iterables.length === 0) return;

  const arrays = iterables.map((it) => toArray(it as AnyIterable<unknown>));
  const minLen = Math.min(...arrays.map((a) => a.length));

  for (let i = 0; i < minLen; i++) {
    yield arrays.map((a) => a[i]) as T;
  }
}

/**
 * Zips multiple iterables together, padding shorter ones with `fillValue`.
 * Continues until the longest iterable is exhausted.
 *
 * @example
 * [...zipLongest([1,2,3], ['a','b'], { fillValue: null })]
 * // [[1,'a'],[2,'b'],[3,null]]
 */
export function* zipLongest<T extends unknown[], F = undefined>(
  ...args: [...{ [K in keyof T]: AnyIterable<T[K]> }, { fillValue?: F }?]
): Generator<(T[number] | F)[]> {
  // Last arg may be options object - detect it
  const lastArg = args[args.length - 1];
  let fillValue: F | undefined;
  let iterables: AnyIterable<unknown>[];

  if (
    lastArg !== null &&
    typeof lastArg === "object" &&
    !Array.isArray(lastArg) &&
    typeof (lastArg as Iterable<unknown>)[Symbol.iterator] !== "function" &&
    "fillValue" in (lastArg as object)
  ) {
    fillValue = (lastArg as { fillValue?: F }).fillValue;
    iterables = args.slice(0, -1) as AnyIterable<unknown>[];
  } else {
    iterables = args as AnyIterable<unknown>[];
  }

  if (iterables.length === 0) return;

  const arrays = iterables.map((it) => toArray(it));
  const maxLen = Math.max(...arrays.map((a) => a.length));

  for (let i = 0; i < maxLen; i++) {
    yield arrays.map((a) => (i < a.length ? a[i] : (fillValue as F)));
  }
}

/**
 * Separates a zipped array (array of tuples) back into per-column arrays.
 * Inverse of zip. Accepts the output of zip() or any tuple array.
 *
 * @example
 * unzip([[1,'a'],[2,'b'],[3,'c']]) // [[1,2,3],['a','b','c']]
 */
export function unzip<T extends unknown[]>(
  zipped: readonly T[]
): { [K in keyof T]: T[K][] } {
  if (zipped.length === 0) return [] as unknown as { [K in keyof T]: T[K][] };

  const width = zipped[0].length;
  const result: unknown[][] = Array.from({ length: width }, () => []);

  for (const tuple of zipped) {
    for (let col = 0; col < width; col++) {
      result[col].push(tuple[col]);
    }
  }

  return result as { [K in keyof T]: T[K][] };
}

/**
 * Zips multiple iterables and maps each tuple through a function.
 * Stops at the shortest iterable (like zip).
 *
 * @example
 * [...zipWith((a, b) => a + b, [1,2,3], [10,20,30])] // [11,22,33]
 */
export function* zipWith<T extends unknown[], R>(
  fn: (...args: T) => R,
  ...iterables: { [K in keyof T]: AnyIterable<T[K]> }
): Generator<R> {
  for (const tuple of zip<T>(...iterables)) {
    yield fn(...tuple);
  }
}
