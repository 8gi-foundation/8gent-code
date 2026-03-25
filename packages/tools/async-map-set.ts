/**
 * AsyncMap and AsyncSet - Map and Set with async iteration and operations.
 *
 * Provides async-native variants of Map and Set for use in agent tool runners,
 * memory stores, and orchestration pipelines where values may be derived from
 * async factories or filtered by async predicates.
 */

// ---------------------------------------------------------------------------
// AsyncMap
// ---------------------------------------------------------------------------

export class AsyncMap<K, V> {
  private readonly _map: Map<K, V>;

  constructor(entries?: Iterable<[K, V]>) {
    this._map = new Map(entries);
  }

  get size(): number {
    return this._map.size;
  }

  get(key: K): V | undefined {
    return this._map.get(key);
  }

  set(key: K, value: V): this {
    this._map.set(key, value);
    return this;
  }

  has(key: K): boolean {
    return this._map.has(key);
  }

  delete(key: K): boolean {
    return this._map.delete(key);
  }

  clear(): void {
    this._map.clear();
  }

  keys(): IterableIterator<K> {
    return this._map.keys();
  }

  values(): IterableIterator<V> {
    return this._map.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this._map.entries();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this._map[Symbol.iterator]();
  }

  /**
   * Return existing value for key. If missing, call asyncFactory to create it,
   * store the result, and return it. Concurrent calls for the same missing key
   * each invoke the factory independently - no deduplication is performed.
   */
  async getOrCreate(key: K, asyncFactory: (key: K) => Promise<V>): Promise<V> {
    if (this._map.has(key)) {
      return this._map.get(key) as V;
    }
    const value = await asyncFactory(key);
    this._map.set(key, value);
    return value;
  }

  /**
   * Return a new AsyncMap where every value has been replaced by the result of
   * applying asyncFn to the original value and key.
   */
  async mapValues<W>(asyncFn: (value: V, key: K) => Promise<W>): Promise<AsyncMap<K, W>> {
    const result = new AsyncMap<K, W>();
    const promises: Promise<void>[] = [];
    for (const [key, value] of this._map) {
      promises.push(
        asyncFn(value, key).then((mapped) => {
          result.set(key, mapped);
        }),
      );
    }
    await Promise.all(promises);
    return result;
  }

  /**
   * Return a new AsyncMap containing only the entries for which asyncPred
   * resolves to true.
   */
  async filterEntries(asyncPred: (value: V, key: K) => Promise<boolean>): Promise<AsyncMap<K, V>> {
    const result = new AsyncMap<K, V>();
    const checks = await Promise.all(
      Array.from(this._map.entries()).map(async ([key, value]) => ({
        key,
        value,
        keep: await asyncPred(value, key),
      })),
    );
    for (const { key, value, keep } of checks) {
      if (keep) result.set(key, value);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// AsyncSet
// ---------------------------------------------------------------------------

export class AsyncSet<T> {
  private readonly _set: Set<T>;

  constructor(values?: Iterable<T>) {
    this._set = new Set(values);
  }

  get size(): number {
    return this._set.size;
  }

  add(value: T): this {
    this._set.add(value);
    return this;
  }

  has(value: T): boolean {
    return this._set.has(value);
  }

  delete(value: T): boolean {
    return this._set.delete(value);
  }

  clear(): void {
    this._set.clear();
  }

  values(): IterableIterator<T> {
    return this._set.values();
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this._set[Symbol.iterator]();
  }

  /**
   * Resolve asyncItem and add the result to the set. Returns this for chaining
   * after the await resolves.
   */
  async addAsync(asyncItem: Promise<T>): Promise<this> {
    const value = await asyncItem;
    this._set.add(value);
    return this;
  }

  /**
   * Return a new AsyncSet containing only the values for which asyncPred
   * resolves to true. All predicates run in parallel.
   */
  async filterAsync(asyncPred: (value: T) => Promise<boolean>): Promise<AsyncSet<T>> {
    const checks = await Promise.all(
      Array.from(this._set).map(async (value) => ({
        value,
        keep: await asyncPred(value),
      })),
    );
    const result = new AsyncSet<T>();
    for (const { value, keep } of checks) {
      if (keep) result.add(value);
    }
    return result;
  }
}
