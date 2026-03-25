/**
 * watch-value.ts
 *
 * Watchable<T> - a value container that notifies subscribers on change.
 * Supports both setter-based (synchronous) and poll-based (interval) change detection.
 */

export type ChangeCallback<T> = (next: T, prev: T) => void;
export type Getter<T> = () => T;

interface Subscription<T> {
  id: number;
  callback: ChangeCallback<T>;
  pollInterval?: ReturnType<typeof setInterval>;
}

let _idCounter = 0;
function nextId(): number {
  return ++_idCounter;
}

/**
 * Watchable<T> wraps a value and fires registered callbacks whenever it changes.
 * Change detection uses strict equality (===). For object/array values, call
 * set() with a new reference to trigger callbacks.
 */
export class Watchable<T> {
  private _value: T;
  private _subscriptions: Map<number, Subscription<T>> = new Map();

  constructor(initial: T) {
    this._value = initial;
  }

  /** Return the current value. */
  get(): T {
    return this._value;
  }

  /**
   * Set a new value. If the new value is strictly different from the current
   * value, all registered onChange callbacks are fired synchronously before
   * this method returns.
   */
  set(value: T): void {
    if (value === this._value) return;
    const prev = this._value;
    this._value = value;
    for (const sub of this._subscriptions.values()) {
      try {
        sub.callback(value, prev);
      } catch (err) {
        // Isolate subscriber errors - do not let one bad callback block others.
        console.error("[watch-value] callback error:", err);
      }
    }
  }

  /**
   * Register a callback that fires on every setter-based change.
   * Returns an unsubscribe function.
   */
  onChange(fn: ChangeCallback<T>): () => void {
    const id = nextId();
    this._subscriptions.set(id, { id, callback: fn });
    return () => this.unwatch(id);
  }

  /**
   * Poll an external getter at the given interval (ms, default 200).
   * When the getter returns a value !== the last seen value, the callback fires
   * and the internal stored value is updated.
   *
   * Returns an unsubscribe function. Call it or use unwatch(id) to stop polling.
   */
  watch(getter: Getter<T>, callback: ChangeCallback<T>, intervalMs = 200): () => void {
    const id = nextId();

    const tick = () => {
      const next = getter();
      if (next !== this._value) {
        const prev = this._value;
        this._value = next;
        try {
          callback(next, prev);
        } catch (err) {
          console.error("[watch-value] poll callback error:", err);
        }
        // Also fire any other onChange subscribers registered on this Watchable.
        for (const sub of this._subscriptions.values()) {
          if (sub.id === id) continue;
          try {
            sub.callback(next, prev);
          } catch (err) {
            console.error("[watch-value] onChange callback error:", err);
          }
        }
      }
    };

    const timer = setInterval(tick, intervalMs);
    this._subscriptions.set(id, { id, callback, pollInterval: timer });

    return () => this.unwatch(id);
  }

  /**
   * Remove a subscription by its numeric id.
   * Poll subscriptions have their interval cleared automatically.
   */
  unwatch(id: number): void {
    const sub = this._subscriptions.get(id);
    if (!sub) return;
    if (sub.pollInterval !== undefined) {
      clearInterval(sub.pollInterval);
    }
    this._subscriptions.delete(id);
  }

  /** Remove all subscriptions and clear all poll intervals. */
  dispose(): void {
    for (const sub of this._subscriptions.values()) {
      if (sub.pollInterval !== undefined) {
        clearInterval(sub.pollInterval);
      }
    }
    this._subscriptions.clear();
  }

  /** Number of active subscriptions (onChange + watch). */
  get subscriberCount(): number {
    return this._subscriptions.size;
  }
}

/**
 * Convenience factory. Creates a Watchable and immediately attaches a poll
 * watcher for the supplied getter.
 *
 * Example:
 *   const w = watch(() => process.env.NODE_ENV, (next, prev) => console.log(next, prev));
 *   // later:
 *   w.dispose();
 */
export function watch<T>(
  getter: Getter<T>,
  callback: ChangeCallback<T>,
  intervalMs = 200
): Watchable<T> {
  const initial = getter();
  const w = new Watchable<T>(initial);
  w.watch(getter, callback, intervalMs);
  return w;
}
