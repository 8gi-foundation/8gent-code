/**
 * TC39 Iterator Helpers polyfill
 * Wraps any iterable with chainable helper methods:
 * map, filter, take, drop, flatMap, reduce, toArray, forEach, some, every, find
 *
 * Usage:
 *   import { iter } from './iterator-helpers';
 *   const result = iter([1, 2, 3, 4, 5])
 *     .filter(x => x % 2 === 0)
 *     .map(x => x * 10)
 *     .toArray(); // [20, 40]
 */

export interface EnhancedIterator<T> {
  map<U>(fn: (value: T) => U): EnhancedIterator<U>;
  filter(fn: (value: T) => boolean): EnhancedIterator<T>;
  take(limit: number): EnhancedIterator<T>;
  drop(count: number): EnhancedIterator<T>;
  flatMap<U>(fn: (value: T) => Iterable<U>): EnhancedIterator<U>;
  reduce<U>(fn: (acc: U, value: T) => U, initial: U): U;
  toArray(): T[];
  forEach(fn: (value: T) => void): void;
  some(fn: (value: T) => boolean): boolean;
  every(fn: (value: T) => boolean): boolean;
  find(fn: (value: T) => boolean): T | undefined;
  [Symbol.iterator](): Iterator<T>;
}

class IterHelper<T> implements EnhancedIterator<T> {
  private source: Iterable<T>;

  constructor(source: Iterable<T>) {
    this.source = source;
  }

  [Symbol.iterator](): Iterator<T> {
    return this.source[Symbol.iterator]();
  }

  map<U>(fn: (value: T) => U): EnhancedIterator<U> {
    const source = this.source;
    return new IterHelper<U>({
      [Symbol.iterator](): Iterator<U> {
        const inner = source[Symbol.iterator]();
        return {
          next(): IteratorResult<U> {
            const step = inner.next();
            if (step.done) return { value: undefined as unknown as U, done: true };
            return { value: fn(step.value), done: false };
          },
        };
      },
    });
  }

  filter(fn: (value: T) => boolean): EnhancedIterator<T> {
    const source = this.source;
    return new IterHelper<T>({
      [Symbol.iterator](): Iterator<T> {
        const inner = source[Symbol.iterator]();
        return {
          next(): IteratorResult<T> {
            while (true) {
              const step = inner.next();
              if (step.done) return { value: undefined as unknown as T, done: true };
              if (fn(step.value)) return { value: step.value, done: false };
            }
          },
        };
      },
    });
  }

  take(limit: number): EnhancedIterator<T> {
    const source = this.source;
    return new IterHelper<T>({
      [Symbol.iterator](): Iterator<T> {
        const inner = source[Symbol.iterator]();
        let count = 0;
        return {
          next(): IteratorResult<T> {
            if (count >= limit) return { value: undefined as unknown as T, done: true };
            const step = inner.next();
            if (step.done) return step;
            count++;
            return step;
          },
        };
      },
    });
  }

  drop(n: number): EnhancedIterator<T> {
    const source = this.source;
    return new IterHelper<T>({
      [Symbol.iterator](): Iterator<T> {
        const inner = source[Symbol.iterator]();
        let dropped = 0;
        return {
          next(): IteratorResult<T> {
            while (dropped < n) {
              const step = inner.next();
              if (step.done) return step;
              dropped++;
            }
            return inner.next();
          },
        };
      },
    });
  }

  flatMap<U>(fn: (value: T) => Iterable<U>): EnhancedIterator<U> {
    const source = this.source;
    return new IterHelper<U>({
      [Symbol.iterator](): Iterator<U> {
        const outer = source[Symbol.iterator]();
        let inner: Iterator<U> | null = null;
        return {
          next(): IteratorResult<U> {
            while (true) {
              if (inner) {
                const step = inner.next();
                if (!step.done) return step;
                inner = null;
              }
              const outerStep = outer.next();
              if (outerStep.done) return { value: undefined as unknown as U, done: true };
              inner = fn(outerStep.value)[Symbol.iterator]();
            }
          },
        };
      },
    });
  }

  reduce<U>(fn: (acc: U, value: T) => U, initial: U): U {
    let acc = initial;
    for (const value of this.source) {
      acc = fn(acc, value);
    }
    return acc;
  }

  toArray(): T[] {
    return [...this.source];
  }

  forEach(fn: (value: T) => void): void {
    for (const value of this.source) {
      fn(value);
    }
  }

  some(fn: (value: T) => boolean): boolean {
    for (const value of this.source) {
      if (fn(value)) return true;
    }
    return false;
  }

  every(fn: (value: T) => boolean): boolean {
    for (const value of this.source) {
      if (!fn(value)) return false;
    }
    return true;
  }

  find(fn: (value: T) => boolean): T | undefined {
    for (const value of this.source) {
      if (fn(value)) return value;
    }
    return undefined;
  }
}

/**
 * Wrap any iterable with TC39 iterator helper methods.
 * @param iterable - Any iterable (array, Set, Map values, generator, etc.)
 * @returns EnhancedIterator with chainable helpers
 */
export function iter<T>(iterable: Iterable<T>): EnhancedIterator<T> {
  return new IterHelper<T>(iterable);
}
