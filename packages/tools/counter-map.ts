/**
 * Counter<T> - Python-style frequency counter for any key type.
 * Self-contained, zero external deps.
 */
export class Counter<T> {
  private counts: Map<T, number>;

  constructor(initial?: Iterable<T> | Map<T, number> | Record<string, number>) {
    this.counts = new Map();

    if (!initial) return;

    if (initial instanceof Map) {
      for (const [k, v] of initial) this.counts.set(k, v);
    } else if (
      typeof initial === "object" &&
      !Symbol.iterator in Object(initial)
    ) {
      for (const [k, v] of Object.entries(initial as Record<string, number>)) {
        this.counts.set(k as unknown as T, v);
      }
    } else {
      for (const item of initial as Iterable<T>) {
        this.increment(item);
      }
    }
  }

  /** Increment key by n (default 1). Creates with value n if absent. */
  increment(key: T, n: number = 1): this {
    this.counts.set(key, (this.counts.get(key) ?? 0) + n);
    return this;
  }

  /** Decrement key by n (default 1). Does not go below zero; removes at zero. */
  decrement(key: T, n: number = 1): this {
    const current = this.counts.get(key) ?? 0;
    const next = current - n;
    if (next <= 0) {
      this.counts.delete(key);
    } else {
      this.counts.set(key, next);
    }
    return this;
  }

  /** Get count for key. Returns 0 if absent. */
  get(key: T): number {
    return this.counts.get(key) ?? 0;
  }

  /** Returns true if key exists with count > 0. */
  has(key: T): boolean {
    return (this.counts.get(key) ?? 0) > 0;
  }

  /** Remove a key entirely. */
  delete(key: T): boolean {
    return this.counts.delete(key);
  }

  /** Sum of all counts. */
  total(): number {
    let sum = 0;
    for (const v of this.counts.values()) sum += v;
    return sum;
  }

  /** Number of distinct keys. */
  size(): number {
    return this.counts.size;
  }

  /** All [key, count] pairs, descending by count. */
  entries(): [T, number][] {
    return [...this.counts.entries()].sort((a, b) => b[1] - a[1]);
  }

  /** Top n keys by count. Returns all if n omitted or >= size. */
  mostCommon(n?: number): [T, number][] {
    const sorted = this.entries();
    return n !== undefined ? sorted.slice(0, n) : sorted;
  }

  /** Bottom n keys by count (ascending). Returns all if n omitted. */
  leastCommon(n?: number): [T, number][] {
    const sorted = [...this.counts.entries()].sort((a, b) => a[1] - b[1]);
    return n !== undefined ? sorted.slice(0, n) : sorted;
  }

  /** Add counts from another Counter in-place. Returns this. */
  merge(other: Counter<T>): this {
    for (const [k, v] of other.counts) {
      this.counts.set(k, (this.counts.get(k) ?? 0) + v);
    }
    return this;
  }

  /** Subtract counts from another Counter in-place. Removes keys at/below zero. Returns this. */
  subtract(other: Counter<T>): this {
    for (const [k, v] of other.counts) {
      const next = (this.counts.get(k) ?? 0) - v;
      if (next <= 0) {
        this.counts.delete(k);
      } else {
        this.counts.set(k, next);
      }
    }
    return this;
  }

  /** Reset all counts. */
  clear(): this {
    this.counts.clear();
    return this;
  }

  /** Iterate over [key, count] pairs in insertion order. */
  [Symbol.iterator](): IterableIterator<[T, number]> {
    return this.counts.entries();
  }

  /** Returns a plain object snapshot. Only works when T extends string. */
  toObject(): Record<string, number> {
    const obj: Record<string, number> = {};
    for (const [k, v] of this.counts) obj[String(k)] = v;
    return obj;
  }

  /** Returns a new Counter that is a copy of this one. */
  clone(): Counter<T> {
    return new Counter<T>(new Map(this.counts));
  }
}
