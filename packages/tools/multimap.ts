/**
 * MultiMap<K, V> - a map that stores multiple values per key.
 *
 * Wraps Map<K, V[]> with typed operations for put, get, remove per
 * key-value pair, getAll for a key, has for key-value existence,
 * iteration over keys/values/entries, total size, and clear.
 */
export class MultiMap<K, V> {
  private readonly _map: Map<K, V[]> = new Map();
  private _size = 0;

  /**
   * Add a value under the given key. Duplicate key-value pairs are allowed.
   */
  put(key: K, value: V): this {
    const bucket = this._map.get(key);
    if (bucket) {
      bucket.push(value);
    } else {
      this._map.set(key, [value]);
    }
    this._size++;
    return this;
  }

  /**
   * Return all values stored under the given key.
   * Returns an empty array if the key does not exist.
   */
  getAll(key: K): V[] {
    return this._map.get(key) ?? [];
  }

  /**
   * Return the first value stored under the given key, or undefined.
   */
  get(key: K): V | undefined {
    return this._map.get(key)?.[0];
  }

  /**
   * Remove the first occurrence of a specific value under the given key.
   * Returns true if a value was removed, false otherwise.
   */
  remove(key: K, value: V): boolean {
    const bucket = this._map.get(key);
    if (!bucket) return false;

    const idx = bucket.indexOf(value);
    if (idx === -1) return false;

    bucket.splice(idx, 1);
    this._size--;

    if (bucket.length === 0) {
      this._map.delete(key);
    }

    return true;
  }

  /**
   * Remove all values stored under the given key.
   * Returns the number of values removed.
   */
  removeAll(key: K): number {
    const bucket = this._map.get(key);
    if (!bucket) return 0;

    const removed = bucket.length;
    this._map.delete(key);
    this._size -= removed;
    return removed;
  }

  /**
   * Return true if this key exists in the map (has at least one value).
   */
  hasKey(key: K): boolean {
    return this._map.has(key);
  }

  /**
   * Return true if the exact key-value pair exists.
   */
  has(key: K, value: V): boolean {
    return this._map.get(key)?.includes(value) ?? false;
  }

  /**
   * Total number of values across all keys.
   */
  get size(): number {
    return this._size;
  }

  /**
   * Number of distinct keys.
   */
  get keyCount(): number {
    return this._map.size;
  }

  /** Iterate over distinct keys. */
  keys(): IterableIterator<K> {
    return this._map.keys();
  }

  /** Iterate over all individual values (flattened across all keys). */
  *values(): IterableIterator<V> {
    for (const bucket of this._map.values()) {
      yield* bucket;
    }
  }

  /** Iterate over [key, value] pairs (one entry per value, not per key). */
  *entries(): IterableIterator<[K, V]> {
    for (const [key, bucket] of this._map.entries()) {
      for (const value of bucket) {
        yield [key, value];
      }
    }
  }

  /** Iterate over [key, values[]] pairs (one entry per key). */
  keyEntries(): IterableIterator<[K, V[]]> {
    return this._map.entries();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }

  /** Remove all entries. */
  clear(): void {
    this._map.clear();
    this._size = 0;
  }
}
