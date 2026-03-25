/**
 * range-generator.ts
 *
 * Python-style range() for generating number sequences.
 * Supports generator (lazy) and array (eager) forms, linspace, and chunk.
 */

/**
 * Generates a sequence of numbers lazily (generator).
 *
 * Overloads:
 *   range(stop)              -> 0, 1, ..., stop-1
 *   range(start, stop)       -> start, start+1, ..., stop-1
 *   range(start, stop, step) -> start, start+step, ..., < stop (or > if step < 0)
 *
 * Matches Python's range() semantics exactly:
 *   - step defaults to 1
 *   - yields nothing if range is empty (e.g. start >= stop with positive step)
 *   - supports negative step for countdown
 */
export function* range(stop: number): Generator<number>;
export function* range(start: number, stop: number): Generator<number>;
export function* range(start: number, stop: number, step: number): Generator<number>;
export function* range(
  startOrStop: number,
  stop?: number,
  step?: number,
): Generator<number> {
  let start: number;

  if (stop === undefined) {
    start = 0;
    stop = startOrStop;
  } else {
    start = startOrStop;
  }

  const s = step ?? 1;

  if (s === 0) {
    throw new RangeError("range() step argument must not be zero");
  }

  if (s > 0) {
    for (let i = start; i < stop; i += s) {
      yield i;
    }
  } else {
    for (let i = start; i > stop; i += s) {
      yield i;
    }
  }
}

/**
 * Eager version of range() - returns a number array.
 * Same overload signatures as range().
 */
export function rangeArray(stop: number): number[];
export function rangeArray(start: number, stop: number): number[];
export function rangeArray(start: number, stop: number, step: number): number[];
export function rangeArray(
  startOrStop: number,
  stop?: number,
  step?: number,
): number[] {
  if (stop === undefined) {
    return [...range(startOrStop)];
  }
  if (step === undefined) {
    return [...range(startOrStop, stop)];
  }
  return [...range(startOrStop, stop, step)];
}

/**
 * Returns `count` evenly spaced numbers from `start` to `stop` (inclusive).
 * Mirrors NumPy's linspace(start, stop, num).
 *
 * linspace(0, 1, 5) -> [0, 0.25, 0.5, 0.75, 1]
 */
export function linspace(start: number, stop: number, count: number): number[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError("linspace() count must be a non-negative integer");
  }
  if (count === 0) return [];
  if (count === 1) return [start];

  const result: number[] = [];
  const step = (stop - start) / (count - 1);
  for (let i = 0; i < count; i++) {
    result.push(start + step * i);
  }
  // Guarantee the last element is exactly `stop` (avoids float drift)
  result[count - 1] = stop;
  return result;
}

/**
 * Splits an array into chunks of `size`. The last chunk may be smaller.
 *
 * chunk([1,2,3,4,5], 2) -> [[1,2],[3,4],[5]]
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError("chunk() size must be a positive integer");
  }
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
