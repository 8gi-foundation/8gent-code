/**
 * Generic binary search utilities for sorted collections.
 *
 * All operations assume the input array is sorted in ascending order
 * according to the provided comparator (defaults to natural <).
 */

/** Returns negative if a < b, 0 if equal, positive if a > b. */
export type Comparator<T> = (a: T, b: T) => number;

const defaultCmp = <T>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Binary search. Returns the index of the first element that equals target,
 * or -1 if not found.
 */
export function binarySearch<T>(
  arr: readonly T[],
  target: T,
  cmp: Comparator<T> = defaultCmp,
): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const result = cmp(arr[mid], target);
    if (result === 0) return mid;
    if (result < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Lower bound. Returns the index of the first element >= target.
 * Returns arr.length if all elements are < target.
 */
export function lowerBound<T>(
  arr: readonly T[],
  target: T,
  cmp: Comparator<T> = defaultCmp,
): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cmp(arr[mid], target) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Upper bound. Returns the index of the first element > target.
 * Returns arr.length if all elements are <= target.
 */
export function upperBound<T>(
  arr: readonly T[],
  target: T,
  cmp: Comparator<T> = defaultCmp,
): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cmp(arr[mid], target) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Insertion point. Returns the index where target should be inserted
 * to keep the array sorted (equivalent to lowerBound).
 */
export function insertionPoint<T>(
  arr: readonly T[],
  target: T,
  cmp: Comparator<T> = defaultCmp,
): number {
  return lowerBound(arr, target, cmp);
}

/**
 * Range search. Returns [startIndex, endIndex) (exclusive end) of all
 * elements equal to target. Returns [i, i] (empty range) if not found.
 */
export function rangeSearch<T>(
  arr: readonly T[],
  target: T,
  cmp: Comparator<T> = defaultCmp,
): [number, number] {
  const lo = lowerBound(arr, target, cmp);
  if (lo >= arr.length || cmp(arr[lo], target) !== 0) return [lo, lo];
  return [lo, upperBound(arr, target, cmp)];
}

/**
 * Search in a sorted array of objects by a specific key.
 * The array must be sorted by the given key in ascending order.
 *
 * @example
 * const users = [{ id: 1 }, { id: 3 }, { id: 7 }];
 * searchByKey(users, 'id', 3); // returns 1
 */
export function searchByKey<T, K extends keyof T>(
  arr: readonly T[],
  key: K,
  value: T[K],
): number {
  const cmp: Comparator<T> = (a, b) =>
    a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
  return binarySearch(arr, { [key]: value } as unknown as T, cmp);
}

/**
 * Lower bound in sorted objects by key.
 */
export function lowerBoundByKey<T, K extends keyof T>(
  arr: readonly T[],
  key: K,
  value: T[K],
): number {
  const cmp: Comparator<T> = (a, b) =>
    a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
  return lowerBound(arr, { [key]: value } as unknown as T, cmp);
}

/**
 * Upper bound in sorted objects by key.
 */
export function upperBoundByKey<T, K extends keyof T>(
  arr: readonly T[],
  key: K,
  value: T[K],
): number {
  const cmp: Comparator<T> = (a, b) =>
    a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
  return upperBound(arr, { [key]: value } as unknown as T, cmp);
}
