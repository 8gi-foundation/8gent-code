/**
 * state-container.ts
 *
 * Minimal Zustand-style state container.
 * createStore(initialState) returns { getState, setState, subscribe, destroy }.
 *
 * Features:
 *   - setState accepts partial state or an updater function
 *   - subscribe(listener) returns an unsubscribe function
 *   - subscribeSelector(selector, listener) for selector-based subscriptions
 *   - destroy() clears all listeners and prevents further updates
 */

export type Listener<T> = (state: T, prev: T) => void;
export type Selector<T, U> = (state: T) => U;
export type Updater<T> = (prev: T) => Partial<T>;

export interface Store<T extends object> {
  /** Return current state snapshot (shallow clone). */
  getState(): T;
  /** Merge partial state or apply updater function. */
  setState(update: Partial<T> | Updater<T>): void;
  /** Subscribe to all state changes. Returns unsubscribe. */
  subscribe(listener: Listener<T>): () => void;
  /** Subscribe to a derived slice. Listener fires only when slice changes. */
  subscribeSelector<U>(selector: Selector<T, U>, listener: (value: U, prev: U) => void): () => void;
  /** Tear down - clears listeners, prevents further updates. */
  destroy(): void;
}

/**
 * Create a minimal reactive state container.
 *
 * @example
 * const store = createStore({ count: 0, name: "eight" });
 * const unsub = store.subscribe((s) => console.log(s.count));
 * store.setState({ count: 1 });
 * store.setState((prev) => ({ count: prev.count + 1 }));
 * unsub();
 * store.destroy();
 */
export function createStore<T extends object>(initialState: T): Store<T> {
  let state: T = { ...initialState };
  let listeners = new Set<Listener<T>>();
  let destroyed = false;

  function assertAlive(): void {
    if (destroyed) {
      throw new Error("state-container: store has been destroyed");
    }
  }

  function notify(prev: T): void {
    for (const listener of listeners) {
      try {
        listener(state, prev);
      } catch (err) {
        // Isolate listener errors - don't break other subscribers
        console.error("state-container: listener threw", err);
      }
    }
  }

  const store: Store<T> = {
    getState(): T {
      // Return shallow clone so callers cannot mutate internal state
      return { ...state };
    },

    setState(update: Partial<T> | Updater<T>): void {
      assertAlive();
      const prev = state;
      const patch = typeof update === "function" ? (update as Updater<T>)(prev) : update;
      state = { ...prev, ...patch };
      notify(prev);
    },

    subscribe(listener: Listener<T>): () => void {
      assertAlive();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    subscribeSelector<U>(
      selector: Selector<T, U>,
      listener: (value: U, prev: U) => void
    ): () => void {
      assertAlive();
      let current = selector(state);

      const wrapped: Listener<T> = (next) => {
        const selected = selector(next);
        if (!Object.is(selected, current)) {
          const prevSelected = current;
          current = selected;
          listener(current, prevSelected);
        }
      };

      listeners.add(wrapped);
      return () => {
        listeners.delete(wrapped);
      };
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
    },
  };

  return store;
}

export default createStore;
