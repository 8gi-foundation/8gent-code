/**
 * SortedArray<T> - maintains a sorted array with O(log n) insertion.
 * Binary search for position, splice insert. Remove, indexOf, range query,
 * min/max O(1), and sorted merge of two SortedArrays.
 */

export type Comparator<T> = (a: T, b: T) => number;

const defaultComparator = <T>(a: T, b: T): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

export class SortedArray<T> {
  private items: T[];
  private compare: Comparator<T>;

  constructor(comparator?: Comparator<T>, initial?: T[]) {
    this.compare = comparator ?? defaultComparator;
    this.items = [];
    if (initial) {
      for (const item of initial) this.insert(item);
    }
  }

  /** Number of elements. */
  get length(): number {
    return this.items.length;
  }

  /** O(1) minimum element, or undefined if empty. */
  min(): T | undefined {
    return this.items[0];
  }

  /** O(1) maximum element, or undefined if empty. */
  max(): T | undefined {
    return this.items[this.items.length - 1];
  }

  /** Binary search: find the index where value should be inserted. O(log n). */
  private bisect(value: T): number {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.compare(this.items[mid], value) < 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /** Insert value maintaining sort order. O(log n) search + O(n) splice. */
  insert(value: T): this {
    const idx = this.bisect(value);
    this.items.splice(idx, 0, value);
    return this;
  }

  /**
   * First index of value using binary search. Returns -1 if not found. O(log n).
   * Uses comparator equality (compare returns 0).
   */
  indexOf(value: T): number {
    const idx = this.bisect(value);
    if (idx < this.items.length && this.compare(this.items[idx], value) === 0) {
      return idx;
    }
    return -1;
  }

  /** Remove first occurrence of value. Returns true if removed. O(log n + n). */
  remove(value: T): boolean {
    const idx = this.indexOf(value);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    return true;
  }

  /** Remove all occurrences of value. Returns count removed. O(log n + n). */
  removeAll(value: T): number {
    let count = 0;
    let idx = this.indexOf(value);
    while (idx !== -1) {
      this.items.splice(idx, 1);
      count++;
      idx = this.indexOf(value);
    }
    return count;
  }

  /**
   * Range query: all elements where low <= element <= high.
   * Both bounds inclusive. O(log n + k) where k is results count.
   */
  range(low: T, high: T): T[] {
    const start = this.bisect(low);
    const results: T[] = [];
    for (let i = start; i < this.items.length; i++) {
      if (this.compare(this.items[i], high) > 0) break;
      results.push(this.items[i]);
    }
    return results;
  }

  /** Returns shallow copy of internal array (already sorted). */
  toArray(): T[] {
    return [...this.items];
  }

  /** Read-only access by index. */
  at(index: number): T | undefined {
    return this.items[index];
  }

  /**
   * Merge two SortedArrays into a new SortedArray. O(m + n).
   * Both must use equivalent comparators.
   */
  static merge<T>(a: SortedArray<T>, b: SortedArray<T>, comparator?: Comparator<T>): SortedArray<T> {
    const cmp = comparator ?? (a.compare as Comparator<T>);
    const result = new SortedArray<T>(cmp);
    const aItems = a.items;
    const bItems = b.items;
    let i = 0;
    let j = 0;
    while (i < aItems.length && j < bItems.length) {
      if (cmp(aItems[i], bItems[j]) <= 0) {
        result.items.push(aItems[i++]);
      } else {
        result.items.push(bItems[j++]);
      }
    }
    while (i < aItems.length) result.items.push(aItems[i++]);
    while (j < bItems.length) result.items.push(bItems[j++]);
    return result;
  }

  [Symbol.iterator](): Iterator<T> {
    return this.items[Symbol.iterator]();
  }
}
