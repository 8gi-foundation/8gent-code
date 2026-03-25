/**
 * Lazy evaluation sequence with chainable operations.
 * All intermediate operations are deferred until a terminal call.
 *
 * Usage:
 *   Seq.from([1,2,3,4,5])
 *     .filter(x => x % 2 === 0)
 *     .map(x => x * 10)
 *     .take(5)
 *     .toArray()
 */

type Mapper<T, U> = (value: T) => U;
type Predicate<T> = (value: T) => boolean;
type FlatMapper<T, U> = (value: T) => Iterable<U>;

export class Seq<T> {
  private constructor(private readonly source: () => Iterator<T>) {}

  /** Create a Seq from any iterable (array, Set, generator, etc.) */
  static from<T>(iterable: Iterable<T>): Seq<T> {
    return new Seq<T>(() => iterable[Symbol.iterator]());
  }

  /** Create a Seq from a generator function */
  static fromGenerator<T>(gen: () => Generator<T>): Seq<T> {
    return new Seq<T>(() => gen());
  }

  /** Lazily transform each element */
  map<U>(fn: Mapper<T, U>): Seq<U> {
    const self = this;
    return new Seq<U>(function* () {
      const iter = self.source();
      let result = iter.next();
      while (!result.done) {
        yield fn(result.value);
        result = iter.next();
      }
    });
  }

  /** Lazily keep only elements passing the predicate */
  filter(fn: Predicate<T>): Seq<T> {
    const self = this;
    return new Seq<T>(function* () {
      const iter = self.source();
      let result = iter.next();
      while (!result.done) {
        if (fn(result.value)) yield result.value;
        result = iter.next();
      }
    });
  }

  /** Lazily take at most n elements */
  take(n: number): Seq<T> {
    const self = this;
    return new Seq<T>(function* () {
      if (n <= 0) return;
      let count = 0;
      const iter = self.source();
      let result = iter.next();
      while (!result.done && count < n) {
        yield result.value;
        count++;
        result = iter.next();
      }
    });
  }

  /** Lazily skip the first n elements */
  skip(n: number): Seq<T> {
    const self = this;
    return new Seq<T>(function* () {
      let skipped = 0;
      const iter = self.source();
      let result = iter.next();
      while (!result.done) {
        if (skipped >= n) {
          yield result.value;
        } else {
          skipped++;
        }
        result = iter.next();
      }
    });
  }

  /** Lazily flatten mapped iterables */
  flatMap<U>(fn: FlatMapper<T, U>): Seq<U> {
    const self = this;
    return new Seq<U>(function* () {
      const iter = self.source();
      let result = iter.next();
      while (!result.done) {
        yield* fn(result.value);
        result = iter.next();
      }
    });
  }

  /** Lazily yield only unique elements (uses Set for tracking) */
  distinct(): Seq<T> {
    const self = this;
    return new Seq<T>(function* () {
      const seen = new Set<T>();
      const iter = self.source();
      let result = iter.next();
      while (!result.done) {
        if (!seen.has(result.value)) {
          seen.add(result.value);
          yield result.value;
        }
        result = iter.next();
      }
    });
  }

  // --- Terminal operations ---

  /** Materialize the sequence into an array */
  toArray(): T[] {
    const out: T[] = [];
    const iter = this.source();
    let result = iter.next();
    while (!result.done) {
      out.push(result.value);
      result = iter.next();
    }
    return out;
  }

  /** Reduce to a single value */
  reduce<U>(fn: (acc: U, value: T) => U, initial: U): U {
    let acc = initial;
    const iter = this.source();
    let result = iter.next();
    while (!result.done) {
      acc = fn(acc, result.value);
      result = iter.next();
    }
    return acc;
  }

  /** Iterate with a side-effect function */
  forEach(fn: (value: T) => void): void {
    const iter = this.source();
    let result = iter.next();
    while (!result.done) {
      fn(result.value);
      result = iter.next();
    }
  }

  /** Return the first element or undefined */
  first(): T | undefined {
    const result = this.source().next();
    return result.done ? undefined : result.value;
  }

  /** Count elements (consumes the sequence) */
  count(): number {
    return this.reduce((acc) => acc + 1, 0);
  }

  /** Make Seq itself iterable */
  [Symbol.iterator](): Iterator<T> {
    return this.source();
  }
}
