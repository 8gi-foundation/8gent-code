/**
 * value-store.ts
 * Observable value store with change subscriptions, history, and transform.
 * Status: quarantine - not wired into agent tool registry.
 *
 * Usage:
 *   const store = new ValueStore(0);
 *   store.subscribe((val, prev) => console.log(prev, "->", val));
 *   store.set(1);         // triggers subscriber
 *   store.history(3);     // [0, 1]
 *   store.previous();     // 0
 *   store.transform((n) => n * 2);  // sets to 2
 *   store.reset(0);       // back to initial
 */

export type Subscriber<T> = (value: T, previous: T | undefined) => void;
export type Unsubscribe = () => void;

export interface ValueStoreOptions {
  /** Maximum number of historical values to retain (not counting current). Default: 50. */
  maxHistory?: number;
}

export class ValueStore<T> {
  private _value: T;
  private readonly _initial: T;
  private _history: T[] = [];
  private _subscribers: Set<Subscriber<T>> = new Set();
  private readonly _maxHistory: number;

  constructor(initial: T, options: ValueStoreOptions = {}) {
    this._initial = initial;
    this._value = initial;
    this._maxHistory = options.maxHistory ?? 50;
  }

  /**
   * Returns the current value.
   */
  get(): T {
    return this._value;
  }

  /**
   * Sets a new value and notifies all subscribers.
   * No-op if the value is strictly equal to the current value.
   */
  set(value: T): void {
    if (value === this._value) return;

    const previous = this._value;

    // Persist to history before overwriting
    this._history.push(previous);
    if (this._history.length > this._maxHistory) {
      this._history.shift();
    }

    this._value = value;
    this._notify(value, previous);
  }

  /**
   * Apply a transform function to the current value and set the result.
   * Synchronous only - for async transforms, await the result externally and call set().
   */
  transform(fn: (current: T) => T): void {
    this.set(fn(this._value));
  }

  /**
   * Subscribe to value changes. The subscriber is called with (newValue, previousValue).
   * Returns an unsubscribe function.
   */
  subscribe(fn: Subscriber<T>): Unsubscribe {
    this._subscribers.add(fn);
    return () => {
      this._subscribers.delete(fn);
    };
  }

  /**
   * Returns the last N historical values (not including the current value),
   * oldest first. Defaults to all retained history.
   */
  history(n?: number): T[] {
    if (n === undefined) return [...this._history];
    return this._history.slice(-n);
  }

  /**
   * Returns the value immediately before the current one, or undefined if
   * no prior values exist.
   */
  previous(): T | undefined {
    return this._history.length > 0
      ? this._history[this._history.length - 1]
      : undefined;
  }

  /**
   * Resets the store to a new initial value.
   * Clears all history. Notifies subscribers with the reset value.
   */
  reset(initial?: T): void {
    const next = initial !== undefined ? initial : this._initial;
    const previous = this._value;
    this._history = [];
    this._value = next;
    if (next !== previous) {
      this._notify(next, previous);
    }
  }

  /**
   * Removes all subscribers without changing the value or history.
   */
  clearSubscribers(): void {
    this._subscribers.clear();
  }

  /**
   * Returns the number of active subscribers.
   */
  subscriberCount(): number {
    return this._subscribers.size;
  }

  private _notify(value: T, previous: T | undefined): void {
    for (const fn of this._subscribers) {
      try {
        fn(value, previous);
      } catch {
        // Subscribers must not throw - swallow silently
      }
    }
  }
}
