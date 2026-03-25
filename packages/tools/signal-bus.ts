/**
 * signal-bus.ts
 * Reactive signal-based state management.
 *
 * API:
 *   signal(initial)   - create a reactive value
 *   computed(fn)      - derive a value from signals
 *   effect(fn)        - run a side-effect when signals change
 *   batch(fn)         - group multiple signal writes into one flush
 */

// --- Internals ---------------------------------------------------------------

type Subscriber = () => void;

let currentEffect: Subscriber | null = null;
let batchDepth = 0;
const pendingEffects = new Set<Subscriber>();

function scheduleEffect(fn: Subscriber): void {
  if (batchDepth > 0) {
    pendingEffects.add(fn);
  } else {
    fn();
  }
}

function flushPending(): void {
  const toRun = [...pendingEffects];
  pendingEffects.clear();
  for (const fn of toRun) fn();
}

// --- Signal ------------------------------------------------------------------

export interface Signal<T> {
  /** Read the current value (tracks dependency if inside effect/computed). */
  (): T;
  /** Write a new value and notify subscribers. */
  set(value: T): void;
  /** Read without tracking (no dependency registration). */
  peek(): T;
}

export function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const subscribers = new Set<Subscriber>();

  function read(): T {
    if (currentEffect !== null) {
      subscribers.add(currentEffect);
    }
    return value;
  }

  read.set = function (next: T): void {
    if (Object.is(value, next)) return;
    value = next;
    for (const sub of [...subscribers]) scheduleEffect(sub);
  };

  read.peek = function (): T {
    return value;
  };

  return read as Signal<T>;
}

// --- Computed ----------------------------------------------------------------

export interface Computed<T> {
  /** Read the derived value (tracks dependency if inside effect/computed). */
  (): T;
  /** Read without tracking. */
  peek(): T;
}

export function computed<T>(fn: () => T): Computed<T> {
  let cached: T;
  let dirty = true;
  const inner = signal<T>(undefined as unknown as T);

  effect(() => {
    const next = fn();
    if (dirty || !Object.is(next, cached)) {
      cached = next;
      dirty = false;
      inner.set(next);
    }
  });

  function read(): T {
    return inner();
  }

  read.peek = function (): T {
    return inner.peek();
  };

  return read as Computed<T>;
}

// --- Effect ------------------------------------------------------------------

/**
 * Run `fn` immediately and re-run whenever any signal read inside it changes.
 * Returns a disposal function that stops tracking.
 */
export function effect(fn: () => void): () => void {
  let disposed = false;

  const runner: Subscriber = () => {
    if (disposed) return;
    const prev = currentEffect;
    currentEffect = runner;
    try {
      fn();
    } finally {
      currentEffect = prev;
    }
  };

  runner();
  return () => { disposed = true; };
}

// --- Batch -------------------------------------------------------------------

/**
 * Group multiple signal writes so effects fire once after all writes complete.
 */
export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) flushPending();
  }
}
