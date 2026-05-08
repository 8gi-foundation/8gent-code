/**
 * HashSet - Set with custom hash function for object equality.
 * Useful when you need value-based equality for objects instead of reference equality.
 */

export type HashFn<T> = (item: T) => string | number;

export class HashSet<T> {
  private map: Map<string | number, T>;
  private hashFn: HashFn<T>;

  constructor(hashFn: HashFn<T>, items?: Iterable<T>) {
    this.hashFn = hashFn;
    this.map = new Map();
    if (items) {
      for (const item of items) {
        this.add(item);
      }
    }
  }

  /** Add an item. Returns true if added, false if already present. */
  add(item: T): boolean {
    const key = this.hashFn(item);
    if (this.map.has(key)) return false;
    this.map.set(key, item);
    return true;
  }

  /** Returns true if an item with the same hash exists. */
  has(item: T): boolean {
    return this.map.has(this.hashFn(item));
  }

  /** Remove an item by hash. Returns true if removed, false if not found. */
  delete(item: T): boolean {
    return this.map.delete(this.hashFn(item));
  }

  /** Number of items in the set. */
  get size(): number {
    return this.map.size;
  }

  /** Return all items as an array. */
  toArray(): T[] {
    return Array.from(this.map.values());
  }

  /** Iterate over all items. */
  [Symbol.iterator](): Iterator<T> {
    return this.map.values();
  }

  /** Return a new HashSet containing items present in both sets. */
  intersection(other: HashSet<T>): HashSet<T> {
    const result = new HashSet<T>(this.hashFn);
    for (const item of this) {
      if (other.has(item)) {
        result.add(item);
      }
    }
    return result;
  }

  /** Return a new HashSet containing all items from both sets. */
  union(other: HashSet<T>): HashSet<T> {
    const result = new HashSet<T>(this.hashFn, this);
    for (const item of other) {
      result.add(item);
    }
    return result;
  }

  /** Return a new HashSet containing items in this set but not in other. */
  difference(other: HashSet<T>): HashSet<T> {
    const result = new HashSet<T>(this.hashFn);
    for (const item of this) {
      if (!other.has(item)) {
        result.add(item);
      }
    }
    return result;
  }

  /** Returns true if every item in this set is also in other. */
  isSubsetOf(other: HashSet<T>): boolean {
    for (const item of this) {
      if (!other.has(item)) return false;
    }
    return true;
  }

  /** Remove all items. */
  clear(): void {
    this.map.clear();
  }
}
