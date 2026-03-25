/**
 * SortedSet<T> - a set that maintains sorted order.
 *
 * Backed by a sorted array with binary search for O(log n) lookup,
 * O(n) insert/delete (acceptable for typical agent use cases up to ~10k items).
 * Supports custom comparators, range queries, nth-element access, and indexOf.
 */

export type Comparator<T> = (a: T, b: T) => number;

const defaultComparator = <T>(a: T, b: T): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

export class SortedSet<T> implements Iterable<T> {
  private items: T[] = [];
  private compare: Comparator<T>;

  constructor(comparator?: Comparator<T>, initial?: Iterable<T>) {
    this.compare = comparator ?? defaultComparator;
    if (initial) {
      for (const item of initial) {
        this.add(item);
      }
    }
  }

  // Binary search: returns index where item exists, or -(insertionPoint + 1)
  private bisect(value: T): number {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const cmp = this.compare(this.items[mid], value);
      if (cmp < 0) lo = mid + 1;
      else if (cmp > 0) hi = mid;
      else return mid;
    }
    return -(lo + 1);
  }

  /** Insert value. No-op if already present. Returns true if inserted. */
  add(value: T): boolean {
    const idx = this.bisect(value);
    if (idx >= 0) return false; // already present
    this.items.splice(-(idx + 1), 0, value);
    return true;
  }

  /** Remove value. Returns true if it was present. */
  delete(value: T): boolean {
    const idx = this.bisect(value);
    if (idx < 0) return false;
    this.items.splice(idx, 1);
    return true;
  }

  /** Returns true if value is in the set. */
  has(value: T): boolean {
    return this.bisect(value) >= 0;
  }

  /** Smallest element, or undefined if empty. */
  min(): T | undefined {
    return this.items[0];
  }

  /** Largest element, or undefined if empty. */
  max(): T | undefined {
    return this.items[this.items.length - 1];
  }

  /**
   * Returns all elements e where from <= e <= to (inclusive).
   * Uses the set's comparator for boundary checks.
   */
  range(from: T, to: T): T[] {
    const startIdx = this.lowerBound(from);
    const endIdx = this.upperBound(to);
    return this.items.slice(startIdx, endIdx);
  }

  /** Element at sorted index (0-based). Returns undefined if out of range. */
  nth(index: number): T | undefined {
    if (index < 0 || index >= this.items.length) return undefined;
    return this.items[index];
  }

  /** Sorted index of value, or -1 if not present. */
  indexOf(value: T): number {
    const idx = this.bisect(value);
    return idx >= 0 ? idx : -1;
  }

  /** Number of elements in the set. */
  get size(): number {
    return this.items.length;
  }

  /** Returns a copy of all elements in sorted order. */
  toArray(): T[] {
    return this.items.slice();
  }

  /** Iterate elements in sorted order. */
  [Symbol.iterator](): Iterator<T> {
    return this.items[Symbol.iterator]();
  }

  // First index where items[i] >= value
  private lowerBound(value: T): number {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.compare(this.items[mid], value) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // First index where items[i] > value
  private upperBound(value: T): number {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.compare(this.items[mid], value) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
