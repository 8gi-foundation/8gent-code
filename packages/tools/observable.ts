/**
 * Creates an observable value.
 * @param initialValue - The initial value of the observable.
 * @returns The observable instance.
 */
function observable<T>(initialValue: T): Observable<T> {
  return new Observable<T>(initialValue);
}

/**
 * Creates a computed observable derived from dependencies.
 * @param deps - Array of dependency observables.
 * @param fn - Function to compute the derived value.
 * @returns The computed observable.
 */
function computed<T>(deps: Observable<unknown>[], fn: (...args: any[]) => T): Observable<T> {
  const obs = new Observable<T>(fn(...deps.map(d => d.peek())));
  let currentValue = obs.peek();
  deps.forEach(dep => {
    dep.subscribe(() => {
      const newValue = fn(...deps.map(d => d.peek()));
      if (newValue !== currentValue) {
        currentValue = newValue;
        obs.setValue(newValue);
      }
    });
  });
  return obs;
}

/**
 * Groups multiple mutations into a single notification.
 * @param fn - Function containing the mutations.
 */
function batch(fn: () => void): void {
  Observable.isBatching = true;
  try {
    fn();
  } finally {
    Observable.isBatching = false;
  }
}

/**
 * Reads the current value of an observable without subscribing.
 * @param obs - The observable to read.
 * @returns The current value.
 */
function peek<T>(obs: Observable<T>): T {
  return obs.peek();
}

class Observable<T> {
  private value: T;
  private subscribers: Set<() => void> = new Set();
  private static isBatching: boolean = false;

  constructor(initialValue: T) {
    this.value = initialValue;
  }

  /**
   * Subscribes to changes in the observable.
   * @param fn - Callback to be invoked on change.
   * @returns Unsubscribe function.
   */
  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /**
   * Sets the value of the observable.
   * @param newValue - The new value.
   */
  setValue(newValue: T): void {
    if (this.value !== newValue) {
      this.value = newValue;
      if (!Observable.isBatching) {
        this._notify();
      }
    }
  }

  private _notify(): void {
    for (const sub of this.subscribers) {
      sub();
    }
  }

  /**
   * Reads the current value without subscribing.
   * @returns The current value.
   */
  peek(): T {
    return this.value;
  }
}

export { observable, computed, batch, peek, Observable };