/**
 * boxed-value.ts
 *
 * Boxed mutable reference for sharing values across closures.
 * Inspired by Rust's Cell<T> / React's useRef - a single owned value
 * that can be passed around and mutated without re-binding.
 *
 * Use cases:
 *   - Share a counter/flag across multiple callbacks
 *   - Track state in a closure without closures fighting over stale references
 *   - Reactive pipelines via subscribe()
 */

export type Subscriber<T> = (next: T, prev: T) => void;
export type Updater<T> = (current: T) => T;
export type Mapper<T, U> = (value: T) => U;

export class Box<T> {
  private _value: T;
  private _subscribers: Set<Subscriber<T>> = new Set();

  constructor(initial: T) {
    this._value = initial;
  }

  /** Read the current value. */
  get(): T {
    return this._value;
  }

  /** Replace the current value. Notifies subscribers if the value changed. */
  set(value: T): void {
    const prev = this._value;
    this._value = value;
    if (!Object.is(prev, value)) {
      for (const fn of this._subscribers) {
        fn(value, prev);
      }
    }
  }

  /**
   * Update the value using a function of the current value.
   * Equivalent to set(update(get())).
   */
  update(fn: Updater<T>): void {
    this.set(fn(this._value));
  }

  /**
   * Map the current value to a new Box.
   * The returned Box is a snapshot - it does NOT stay in sync with this one.
   * For a live derived value, use subscribe() manually.
   */
  map<U>(fn: Mapper<T, U>): Box<U> {
    return new Box(fn(this._value));
  }

  /**
   * Subscribe to value changes.
   * The callback receives (nextValue, prevValue) whenever set() or update() causes a change.
   * Returns an unsubscribe function.
   */
  subscribe(fn: Subscriber<T>): () => void {
    this._subscribers.add(fn);
    return () => {
      this._subscribers.delete(fn);
    };
  }

  /**
   * Returns the primitive value when coerced (e.g. in string templates or arithmetic).
   * Delegates to the boxed value's own valueOf if present.
   */
  valueOf(): T {
    return this._value;
  }

  /** Convenience: JSON serialises as the inner value. */
  toJSON(): T {
    return this._value;
  }

  /** Convenience: string coercion shows the inner value. */
  toString(): string {
    return String(this._value);
  }

  /** Number of active subscribers (useful for debugging). */
  get subscriberCount(): number {
    return this._subscribers.size;
  }

  /**
   * Remove all subscribers. Useful for teardown in tests or disposable contexts.
   */
  dispose(): void {
    this._subscribers.clear();
  }
}

/**
 * Ref<T> is an alias for Box<T> - use whichever name fits the mental model.
 * "Ref" implies a reference slot (like React's useRef).
 * "Box" implies a container (like a value-carrying cell).
 */
export type Ref<T> = Box<T>;

/**
 * Factory: create a Box with an initial value.
 *
 * @example
 *   const count = box(0);
 *   count.update(n => n + 1);
 *   console.log(count.get()); // 1
 */
export function box<T>(initial: T): Box<T> {
  return new Box(initial);
}

/**
 * Factory: create a Ref with an initial value.
 * Alias for box() - use whichever reads better at the call site.
 *
 * @example
 *   const cursor = ref({ line: 0, col: 0 });
 *   cursor.set({ line: 1, col: 5 });
 */
export function ref<T>(initial: T): Ref<T> {
  return new Box(initial);
}
