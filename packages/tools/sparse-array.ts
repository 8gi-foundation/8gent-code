/**
 * SparseArray<T> - memory-efficient sparse array for large index ranges.
 *
 * Uses a Map as backing store so only populated slots consume memory.
 * Suitable for large index ranges where most entries are empty.
 */

export interface RangeEntry<T> {
  index: number;
  value: T;
}

export class SparseArray<T> {
  private store: Map<number, T>;
  private defaultValue: T | undefined;

  constructor(defaultValue?: T) {
    this.store = new Map();
    this.defaultValue = defaultValue;
  }

  /**
   * Get the value at an index. Returns defaultValue if not set.
   */
  get(index: number): T | undefined {
    if (this.store.has(index)) {
      return this.store.get(index);
    }
    return this.defaultValue;
  }

  /**
   * Set the value at an index.
   */
  set(index: number, value: T): void {
    if (index < 0 || !Number.isInteger(index)) {
      throw new RangeError(`Index must be a non-negative integer, got: ${index}`);
    }
    this.store.set(index, value);
  }

  /**
   * Delete the value at an index, reverting it to defaultValue.
   */
  delete(index: number): boolean {
    return this.store.delete(index);
  }

  /**
   * Check whether an index has an explicitly set value.
   */
  has(index: number): boolean {
    return this.store.has(index);
  }

  /**
   * Number of explicitly populated slots.
   */
  get count(): number {
    return this.store.size;
  }

  /**
   * Iterate over all non-empty entries in ascending index order.
   */
  *entries(): IterableIterator<RangeEntry<T>> {
    const sorted = [...this.store.entries()].sort(([a], [b]) => a - b);
    for (const [index, value] of sorted) {
      yield { index, value };
    }
  }

  /**
   * Iterate over values in ascending index order.
   */
  *values(): IterableIterator<T> {
    for (const { value } of this.entries()) {
      yield value;
    }
  }

  /**
   * Return all entries whose index falls within [start, end] inclusive.
   */
  range(start: number, end: number): RangeEntry<T>[] {
    if (start > end) return [];
    const result: RangeEntry<T>[] = [];
    for (const [index, value] of this.store.entries()) {
      if (index >= start && index <= end) {
        result.push({ index, value });
      }
    }
    return result.sort((a, b) => a.index - b.index);
  }

  /**
   * Highest populated index, or -1 if empty.
   */
  get maxIndex(): number {
    if (this.store.size === 0) return -1;
    return Math.max(...this.store.keys());
  }

  /**
   * Lowest populated index, or -1 if empty.
   */
  get minIndex(): number {
    if (this.store.size === 0) return -1;
    return Math.min(...this.store.keys());
  }

  /**
   * Compact to a dense array from index 0 to maxIndex.
   * Gaps are filled with defaultValue (or undefined).
   */
  toDense(): (T | undefined)[] {
    if (this.store.size === 0) return [];
    const max = this.maxIndex;
    const dense: (T | undefined)[] = new Array(max + 1).fill(this.defaultValue);
    for (const [index, value] of this.store.entries()) {
      dense[index] = value;
    }
    return dense;
  }

  /**
   * Remove all entries.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Return a shallow clone with the same entries and default.
   */
  clone(): SparseArray<T> {
    const copy = new SparseArray<T>(this.defaultValue);
    for (const [index, value] of this.store.entries()) {
      copy.store.set(index, value);
    }
    return copy;
  }
}
