/**
 * Reactive observable values with computed derivations.
 *
 * Provides a minimal reactive primitive for agent state management:
 * - Observable<T>: reactive container with get/set/subscribe
 * - Computed<T>: derived value that auto-updates when dependencies change
 * - batch(fn): group multiple mutations, flush subscribers once
 */

type Subscriber<T> = (value: T, prev: T) => void;
type Unsubscribe = () => void;

let batchDepth = 0;
const pendingFlush = new Set<() => void>();

function scheduleFlush(fn: () => void): void {
  if (batchDepth > 0) {
    pendingFlush.add(fn);
  } else {
    fn();
  }
}

let currentComputed: ComputedImpl<unknown> | null = null;

export class Observable<T> {
  private _value: T;
  private _subscribers = new Set<Subscriber<T>>();
  private _dependents = new Set<ComputedImpl<unknown>>();

  constructor(initial: T) {
    this._value = initial;
  }

  get(): T {
    if (currentComputed) {
      this._dependents.add(currentComputed);
      currentComputed._addDependency(this as Observable<unknown>);
    }
    return this._value;
  }

  set(value: T): void {
    if (Object.is(this._value, value)) return;
    const prev = this._value;
    this._value = value;
    for (const dep of this._dependents) {
      dep._invalidate();
    }
    scheduleFlush(() => {
      for (const sub of this._subscribers) {
        sub(this._value, prev);
      }
    });
  }

  update(fn: (current: T) => T): void {
    this.set(fn(this._value));
  }

  subscribe(subscriber: Subscriber<T>): Unsubscribe {
    this._subscribers.add(subscriber);
    return () => this._subscribers.delete(subscriber);
  }

  _removeDependent(dep: ComputedImpl<unknown>): void {
    this._dependents.delete(dep);
  }
}

class ComputedImpl<T> {
  private _fn: () => T;
  private _value!: T;
  private _dirty = true;
  private _subscribers = new Set<Subscriber<T>>();
  private _deps = new Set<Observable<unknown>>();

  constructor(fn: () => T) {
    this._fn = fn;
  }

  get(): T {
    if (this._dirty) this._recompute();
    return this._value;
  }

  private _recompute(): void {
    for (const dep of this._deps) {
      dep._removeDependent(this as ComputedImpl<unknown>);
    }
    this._deps.clear();
    const parent = currentComputed;
    currentComputed = this as ComputedImpl<unknown>;
    const prev = this._value;
    try {
      this._value = this._fn();
    } finally {
      currentComputed = parent;
    }
    this._dirty = false;
    if (!Object.is(this._value, prev)) {
      scheduleFlush(() => {
        for (const sub of this._subscribers) {
          sub(this._value, prev);
        }
      });
    }
  }

  _invalidate(): void {
    if (this._dirty) return;
    this._dirty = true;
    scheduleFlush(() => this._recompute());
  }

  _addDependency(dep: Observable<unknown>): void {
    this._deps.add(dep);
  }

  subscribe(subscriber: Subscriber<T>): Unsubscribe {
    if (this._dirty) this._recompute();
    this._subscribers.add(subscriber);
    return () => this._subscribers.delete(subscriber);
  }
}

export interface Computed<T> {
  get(): T;
  subscribe(subscriber: Subscriber<T>): Unsubscribe;
}

/**
 * Create a reactive observable value.
 * @example
 * const count = observable(0);
 * count.subscribe((v) => console.log('count:', v));
 * count.set(1); // logs "count: 1"
 */
export function observable<T>(initial: T): Observable<T> {
  return new Observable(initial);
}

/**
 * Create a computed value that auto-updates when its dependencies change.
 * @example
 * const a = observable(2);
 * const b = observable(3);
 * const sum = computed(() => a.get() + b.get());
 * sum.get(); // 5 -- a.set(10) -- sum.get() // 13
 */
export function computed<T>(fn: () => T): Computed<T> {
  return new ComputedImpl(fn);
}

/**
 * Group multiple set() calls - subscribers fire once after all mutations.
 * @example
 * batch(() => { x.set(1); y.set(2); }); // single subscriber flush
 */
export function batch(fn: () => void): void {
  batchDepth++;
  try {
    fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) {
      const fns = [...pendingFlush];
      pendingFlush.clear();
      for (const f of fns) f();
    }
  }
}
