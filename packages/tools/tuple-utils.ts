/**
 * tuple-utils - typed tuple creation and manipulation
 *
 * Provides a minimal set of type-safe utilities for working with fixed-length
 * tuples without the overhead of a full functional library.
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** A readonly tuple of at least one element */
export type Tuple = readonly [unknown, ...unknown[]];

/** Map each element of a tuple through a type transform */
export type MapTuple<T extends Tuple, R> = { [K in keyof T]: R };

/** Zip two tuples element-wise */
export type ZippedTuple<A extends Tuple, B extends Tuple> = {
  [K in keyof A]: K extends keyof B ? [A[K], B[K]] : never;
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Create a typed tuple from values.
 * TypeScript infers the exact tuple type rather than a widened array type.
 *
 * @example
 * const t = tuple(1, "hello", true); // [number, string, boolean]
 */
export function tuple<T extends [unknown, ...unknown[]]>(...values: T): T {
  return values;
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/**
 * Return the first element of a tuple.
 */
export function first<T extends Tuple>(t: T): T[0] {
  return t[0];
}

/**
 * Return the second element of a tuple.
 */
export function second<T extends readonly [unknown, unknown, ...unknown[]]>(
  t: T
): T[1] {
  return t[1];
}

/**
 * Return the last element of a tuple.
 * Works at runtime by indexing the final position.
 */
export function last<T extends Tuple>(t: T): T[number] {
  return t[t.length - 1] as T[number];
}

// ---------------------------------------------------------------------------
// Transformation
// ---------------------------------------------------------------------------

/**
 * Map every element of a tuple through a transform function.
 * Returns a new array (tuple shape preserved at runtime).
 */
export function mapTuple<T extends Tuple, R>(
  t: T,
  fn: (value: T[number], index: number) => R
): R[] {
  return (t as readonly unknown[]).map((v, i) => fn(v as T[number], i));
}

/**
 * Zip two tuples together, pairing elements by index.
 * Length is determined by the shorter tuple.
 */
export function zipTuples<A extends Tuple, B extends Tuple>(
  a: A,
  b: B
): [A[number], B[number]][] {
  const len = Math.min(a.length, b.length);
  const result: [A[number], B[number]][] = [];
  for (let i = 0; i < len; i++) {
    result.push([a[i] as A[number], b[i] as B[number]]);
  }
  return result;
}

/**
 * Spread a tuple as positional arguments into a function.
 * Useful for calling functions that accept multiple parameters
 * from a pre-built tuple.
 */
export function spreadTuple<T extends Tuple, R>(
  t: T,
  fn: (...args: T) => R
): R {
  return fn(...(t as Parameters<typeof fn>));
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Compare two tuples element-wise using strict equality (===).
 * Returns true only when both tuples have the same length and every
 * corresponding element passes strict equality.
 */
export function compareTuples(a: Tuple, b: Tuple): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
