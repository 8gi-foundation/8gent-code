/**
 * RecordBuilder - immutable fluent builder for constructing typed records.
 */

export class RecordBuilder<T extends Record<string, unknown>> {
  private readonly _data: Partial<T>;

  constructor(data: Partial<T> = {}) {
    this._data = { ...data };
  }

  set<K extends keyof T>(key: K, value: T[K]): RecordBuilder<T> {
    return new RecordBuilder<T>({ ...this._data, [key]: value });
  }

  setIf<K extends keyof T>(
    condition: boolean | (() => boolean),
    key: K,
    value: T[K]
  ): RecordBuilder<T> {
    const passes = typeof condition === 'function' ? condition() : condition;
    if (!passes) return this;
    return this.set(key, value);
  }

  merge(partial: Partial<T>): RecordBuilder<T> {
    return new RecordBuilder<T>({ ...this._data, ...partial });
  }

  omit<K extends keyof T>(...keys: K[]): RecordBuilder<Omit<T, K>> {
    const next = { ...this._data } as Record<string, unknown>;
    for (const key of keys) {
      delete next[key as string];
    }
    return new RecordBuilder<Omit<T, K>>(next as Partial<Omit<T, K>>);
  }

  pick<K extends keyof T>(...keys: K[]): RecordBuilder<Pick<T, K>> {
    const next: Partial<Pick<T, K>> = {};
    for (const key of keys) {
      if (key in this._data) {
        (next as Record<string, unknown>)[key as string] = this._data[key];
      }
    }
    return new RecordBuilder<Pick<T, K>>(next);
  }

  transform(fn: (data: Readonly<Partial<T>>) => Partial<T>): RecordBuilder<T> {
    return new RecordBuilder<T>(fn(this._data));
  }

  get<K extends keyof T>(key: K): T[K] | undefined {
    return this._data[key] as T[K] | undefined;
  }

  has(key: keyof T): boolean {
    return key in this._data && this._data[key] !== undefined;
  }

  size(): number {
    return Object.keys(this._data).length;
  }

  build(required?: (keyof T)[]): Partial<T> {
    if (required && required.length > 0) {
      const missing = required.filter((k) => !(k in this._data));
      if (missing.length > 0) {
        throw new Error(
          `RecordBuilder: missing required keys: ${missing.map(String).join(', ')}`
        );
      }
    }
    return { ...this._data };
  }

  buildUnsafe(): T {
    return { ...this._data } as T;
  }
}

export function builder<T extends Record<string, unknown>>(
  defaults?: Partial<T>
): RecordBuilder<T> {
  return new RecordBuilder<T>(defaults);
}
