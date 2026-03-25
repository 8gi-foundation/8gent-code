/**
 * OrderedMap<K, V> - a map that preserves insertion order and supports
 * positional access by index. All keyed operations are O(1). Positional
 * operations (nth, indexOf, slice) are O(1) for nth/first/last and O(n)
 * for indexOf and slice.
 */

export class OrderedMap<K, V> {
  private map: Map<K, V> = new Map();
  private keys_: K[] = [];

  /** Number of entries. */
  get size(): number {
    return this.map.size;
  }

  /**
   * Insert or update a key-value pair.
   * If the key is new it is appended to the end of the insertion order.
   * If the key already exists the value is updated in-place (order unchanged).
   */
  set(key: K, value: V): this {
    if (!this.map.has(key)) {
      this.keys_.push(key);
    }
    this.map.set(key, value);
    return this;
  }

  /** Return the value for key, or undefined if absent. */
  get(key: K): V | undefined {
    return this.map.get(key);
  }

  /** True if the key exists. */
  has(key: K): boolean {
    return this.map.has(key);
  }

  /**
   * Remove a key. Returns true if the key existed and was removed.
   * Deletion is O(n) because the keys array must be spliced.
   */
  delete(key: K): boolean {
    if (!this.map.has(key)) return false;
    this.map.delete(key);
    const idx = this.keys_.indexOf(key);
    if (idx !== -1) this.keys_.splice(idx, 1);
    return true;
  }

  /** Remove all entries. */
  clear(): void {
    this.map.clear();
    this.keys_ = [];
  }

  /**
   * Return the [key, value] pair at insertion-order index.
   * Supports negative indices (-1 = last). Returns undefined if out of range.
   */
  nth(index: number): [K, V] | undefined {
    const len = this.keys_.length;
    const i = index < 0 ? len + index : index;
    if (i < 0 || i >= len) return undefined;
    const key = this.keys_[i];
    return [key, this.map.get(key) as V];
  }

  /**
   * Return the insertion-order index of key, or -1 if absent.
   */
  indexOf(key: K): number {
    return this.keys_.indexOf(key);
  }

  /** Return the first [key, value] pair, or undefined if empty. */
  first(): [K, V] | undefined {
    return this.nth(0);
  }

  /** Return the last [key, value] pair, or undefined if empty. */
  last(): [K, V] | undefined {
    return this.nth(-1);
  }

  /**
   * Return a new OrderedMap containing entries from index start (inclusive)
   * to end (exclusive). Follows the same semantics as Array.prototype.slice.
   */
  slice(start?: number, end?: number): OrderedMap<K, V> {
    const slicedKeys = this.keys_.slice(start, end);
    const result = new OrderedMap<K, V>();
    for (const key of slicedKeys) {
      result.set(key, this.map.get(key) as V);
    }
    return result;
  }

  /**
   * Return a new OrderedMap with the insertion order reversed.
   * Values are not mutated.
   */
  reverse(): OrderedMap<K, V> {
    const result = new OrderedMap<K, V>();
    for (let i = this.keys_.length - 1; i >= 0; i--) {
      const key = this.keys_[i];
      result.set(key, this.map.get(key) as V);
    }
    return result;
  }

  /**
   * Return all entries as an array in insertion order.
   */
  toArray(): Array<[K, V]> {
    return this.keys_.map((key) => [key, this.map.get(key) as V]);
  }

  /** Iterate over [key, value] pairs in insertion order. */
  [Symbol.iterator](): Iterator<[K, V]> {
    let index = 0;
    const keys = this.keys_;
    const map = this.map;
    return {
      next(): IteratorResult<[K, V]> {
        if (index < keys.length) {
          const key = keys[index++];
          return { value: [key, map.get(key) as V], done: false };
        }
        return { value: undefined as unknown as [K, V], done: true };
      },
    };
  }

  /** Iterate over keys in insertion order. */
  *keys(): IterableIterator<K> {
    for (const key of this.keys_) yield key;
  }

  /** Iterate over values in insertion order. */
  *values(): IterableIterator<V> {
    for (const key of this.keys_) yield this.map.get(key) as V;
  }

  /** Iterate over [key, value] pairs - alias for [Symbol.iterator]. */
  *entries(): IterableIterator<[K, V]> {
    for (const key of this.keys_) yield [key, this.map.get(key) as V];
  }
}
