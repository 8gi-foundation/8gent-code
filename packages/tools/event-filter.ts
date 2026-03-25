/**
 * EventFilter - composable event stream filtering with chainable predicates.
 *
 * Usage:
 *   const filter = createFilter<Event>()
 *     .where(e => e.type === 'click')
 *     .debounce(200)
 *     .distinct()
 *     .take(10);
 *
 *   filter.push(event); // returns filtered event or null
 */

type Predicate<T> = (value: T) => boolean;
type Mapper<T, U> = (value: T) => U;

interface FilterState<T> {
  lastEmit: number;
  lastValue: T | undefined;
  count: number;
  skipped: number;
  buffer: T[];
  throttleLastCall: number;
}

function freshState<T>(): FilterState<T> {
  return {
    lastEmit: 0,
    lastValue: undefined,
    count: 0,
    skipped: 0,
    buffer: [],
    throttleLastCall: 0,
  };
}

export class EventFilter<T> {
  private ops: Array<(value: T, state: FilterState<T>) => T | null>;
  private _state: FilterState<T>;

  constructor(
    ops: Array<(value: T, state: FilterState<T>) => T | null> = [],
    state?: FilterState<T>
  ) {
    this.ops = ops;
    this._state = state ?? freshState<T>();
  }

  push(value: T): T | null {
    let current: T | null = value;
    for (const op of this.ops) {
      if (current === null) return null;
      current = op(current, this._state);
    }
    if (current !== null) {
      this._state.count++;
      this._state.lastValue = current;
      this._state.lastEmit = Date.now();
    }
    return current;
  }

  reset(): this {
    this._state = freshState<T>();
    return this;
  }

  where(predicate: Predicate<T>): EventFilter<T> {
    return this._chain((v) => (predicate(v) ? v : null));
  }

  distinct(keyFn?: (v: T) => unknown): EventFilter<T> {
    return this._chain((v, s) => {
      const key = keyFn ? keyFn(v) : JSON.stringify(v);
      const lastKey =
        s.lastValue !== undefined
          ? keyFn ? keyFn(s.lastValue) : JSON.stringify(s.lastValue)
          : undefined;
      return key === lastKey ? null : v;
    });
  }

  debounce(ms: number): EventFilter<T> {
    return this._chain((v, s) => {
      const now = Date.now();
      if (now - s.lastEmit < ms) return null;
      s.lastEmit = now;
      return v;
    });
  }

  throttle(ms: number): EventFilter<T> {
    return this._chain((v, s) => {
      const now = Date.now();
      if (now - s.throttleLastCall < ms) return null;
      s.throttleLastCall = now;
      return v;
    });
  }

  take(n: number): EventFilter<T> {
    return this._chain((v, s) => (s.count < n ? v : null));
  }

  skip(n: number): EventFilter<T> {
    return this._chain((v, s) => {
      if (s.skipped < n) { s.skipped++; return null; }
      return v;
    });
  }

  map<U>(fn: Mapper<T, U>): EventFilter<U> {
    const newOps = [
      ...(this.ops as unknown as Array<(v: U, s: FilterState<U>) => U | null>),
      (v: U) => fn(v as unknown as T) as unknown as U,
    ];
    return new EventFilter<U>(newOps, freshState<U>());
  }

  buffer(size: number, onFlush: (batch: T[]) => void): EventFilter<T> {
    return this._chain((v, s) => {
      s.buffer.push(v);
      if (s.buffer.length >= size) {
        onFlush([...s.buffer]);
        s.buffer = [];
      }
      return null;
    });
  }

  private _chain(op: (v: T, s: FilterState<T>) => T | null): EventFilter<T> {
    return new EventFilter<T>([...this.ops, op], this._state);
  }
}

export function createFilter<T>(): EventFilter<T> {
  return new EventFilter<T>();
}
