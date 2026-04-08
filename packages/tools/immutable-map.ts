/**
 * ImmutableMap - persistent immutable map with structural sharing.
 *
 * Every mutating operation returns a new ImmutableMap instance, leaving
 * the original untouched. The internal store is a plain frozen object so
 * snapshots remain cheap (no deep-copy, just a spread for the delta).
 */

export class ImmutableMap<K extends string | number | symbol, V> {
  private readonly _store: Readonly<Record<K, V>>;
  private readonly _size: number;

  private constructor(store: Readonly<Record<K, V>>) {
    this._store = store;
    this._size = Object.keys(store).length;
  }

  // ---------------------------------------------------------------------------
  // Static factory
  // ---------------------------------------------------------------------------

  static empty<K extends string | number | symbol, V>(): ImmutableMap<K, V> {
    return new ImmutableMap<K, V>(Object.freeze({} as Record<K, V>));
  }

  static from<K extends string | number | symbol, V>(
    entries: Iterable<readonly [K, V]>
  ): ImmutableMap<K, V> {
    const store = {} as Record<K, V>;
    for (const [k, v] of entries) {
      store[k] = v;
    }
    return new ImmutableMap<K, V>(Object.freeze(store));
  }

  static fromObject<V>(obj: Record<string, V>): ImmutableMap<string, V> {
    return new ImmutableMap<string, V>(Object.freeze({ ...obj }));
  }

  // ---------------------------------------------------------------------------
  // Read operations (no allocation beyond what callers need)
  // ---------------------------------------------------------------------------

  get size(): number {
    return this._size;
  }

  get(key: K): V | undefined {
    return this._store[key];
  }

  has(key: K): boolean {
    return Object.prototype.hasOwnProperty.call(this._store, key);
  }

  *keys(): IterableIterator<K> {
    for (const k of Object.keys(this._store) as K[]) {
      yield k;
    }
  }

  *values(): IterableIterator<V> {
    for (const k of Object.keys(this._store) as K[]) {
      yield this._store[k];
    }
  }

  *entries(): IterableIterator<[K, V]> {
    for (const k of Object.keys(this._store) as K[]) {
      yield [k, this._store[k]];
    }
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }

  // ---------------------------------------------------------------------------
  // Write operations - each returns a new ImmutableMap (structural sharing)
  // ---------------------------------------------------------------------------

  set(key: K, value: V): ImmutableMap<K, V> {
    if (this._store[key] === value && this.has(key)) return this;
    return new ImmutableMap<K, V>(
      Object.freeze({ ...this._store, [key]: value } as Record<K, V>)
    );
  }

  delete(key: K): ImmutableMap<K, V> {
    if (!this.has(key)) return this;
    const next = { ...this._store } as Record<K, V>;
    delete next[key];
    return new ImmutableMap<K, V>(Object.freeze(next));
  }

  /**
   * Merge another map or plain object into this map.
   * Values from `other` overwrite existing keys.
   */
  merge(other: ImmutableMap<K, V> | Partial<Record<K, V>>): ImmutableMap<K, V> {
    const patch =
      other instanceof ImmutableMap ? other._store : (other as Record<K, V>);
    return new ImmutableMap<K, V>(
      Object.freeze({ ...this._store, ...patch } as Record<K, V>)
    );
  }

  // ---------------------------------------------------------------------------
  // Conversion helpers
  // ---------------------------------------------------------------------------

  toObject(): Record<K, V> {
    return { ...this._store } as Record<K, V>;
  }

  toString(): string {
    const pairs = Object.keys(this._store)
      .map((k) => `${k}: ${JSON.stringify(this._store[k as K])}`)
      .join(", ");
    return `ImmutableMap { ${pairs} }`;
  }
}
