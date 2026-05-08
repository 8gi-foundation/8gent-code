/**
 * MultiKeyMap - a map that supports composite (tuple) keys.
 *
 * Keys are serialized via JSON so primitives, arrays, and plain objects
 * all work as key components. Order of key arguments matters.
 *
 * @example
 * const m = new MultiKeyMap<string>();
 * m.set("hello", "en", "greeting");
 * m.get("en", "greeting"); // "hello"
 * m.has("en", "greeting"); // true
 * m.delete("en", "greeting"); // true
 */
export class MultiKeyMap<V> {
  private store = new Map<string, V>();

  /** Serialize a tuple of keys into a single map key. */
  private serialize(keys: unknown[]): string {
    if (keys.length === 0) {
      throw new RangeError("MultiKeyMap requires at least one key component.");
    }
    return JSON.stringify(keys);
  }

  /**
   * Retrieve the value stored under the composite key formed by `...keys`.
   * Returns `undefined` if no entry exists.
   */
  get(...keys: unknown[]): V | undefined {
    return this.store.get(this.serialize(keys));
  }

  /**
   * Store `value` under the composite key formed by `...keys`.
   * Overwrites any existing entry for the same composite key.
   */
  set(value: V, ...keys: unknown[]): this {
    this.store.set(this.serialize(keys), value);
    return this;
  }

  /**
   * Return `true` if an entry exists for the composite key formed by `...keys`.
   */
  has(...keys: unknown[]): boolean {
    return this.store.has(this.serialize(keys));
  }

  /**
   * Delete the entry for the composite key formed by `...keys`.
   * Returns `true` if an entry existed and was removed, `false` otherwise.
   */
  delete(...keys: unknown[]): boolean {
    return this.store.delete(this.serialize(keys));
  }

  /**
   * Iterate over all `[keyTuple, value]` pairs stored in the map.
   * Each `keyTuple` is the parsed array of key components.
   */
  *entries(): IterableIterator<[unknown[], V]> {
    for (const [serialized, value] of this.store.entries()) {
      yield [JSON.parse(serialized) as unknown[], value];
    }
  }

  /**
   * Iterate over all key tuples stored in the map.
   */
  *keys(): IterableIterator<unknown[]> {
    for (const [keyTuple] of this.entries()) {
      yield keyTuple;
    }
  }

  /**
   * Iterate over all values stored in the map.
   */
  *values(): IterableIterator<V> {
    yield* this.store.values();
  }

  /** Number of entries in the map. */
  get size(): number {
    return this.store.size;
  }

  /** Remove all entries. */
  clear(): void {
    this.store.clear();
  }

  /** Make the map directly iterable (same as `entries()`). */
  [Symbol.iterator](): IterableIterator<[unknown[], V]> {
    return this.entries();
  }

  /**
   * Execute `callback` for each entry.
   */
  forEach(callback: (value: V, keyTuple: unknown[], map: this) => void): void {
    for (const [keyTuple, value] of this.entries()) {
      callback(value, keyTuple, this);
    }
  }
}
