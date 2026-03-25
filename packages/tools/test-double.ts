/**
 * test-double.ts
 * Spy, stub, and mock creation for testing.
 * Tracks callCount, calledWith, returnValues. Provides restore() cleanup.
 */

export interface CallRecord {
  args: unknown[];
  returnValue: unknown;
  threwError: boolean;
  error?: unknown;
}

export interface SpyFn<T extends (...args: unknown[]) => unknown> {
  (...args: Parameters<T>): ReturnType<T>;
  callCount: number;
  calledWith: Parameters<T>[];
  returnValues: ReturnType<T>[];
  calls: CallRecord[];
  restore: () => void;
  reset: () => void;
}

export interface StubFn<TReturn = unknown> {
  (...args: unknown[]): TReturn;
  callCount: number;
  calledWith: unknown[][];
  returnValues: TReturn[];
  calls: CallRecord[];
  returns: (value: TReturn) => StubFn<TReturn>;
  returnsSequence: (...values: TReturn[]) => StubFn<TReturn>;
  throws: (error: unknown) => StubFn<TReturn>;
  reset: () => void;
}

export interface MockRecord<TReturn = unknown> {
  callCount: number;
  calledWith: unknown[][];
  returnValues: TReturn[];
  calls: CallRecord[];
}

/**
 * Wraps a function and records all calls without changing its behavior.
 */
export function spy<T extends (...args: unknown[]) => unknown>(fn: T): SpyFn<T> {
  const state = { callCount: 0 };
  const calledWith: Parameters<T>[] = [];
  const returnValues: ReturnType<T>[] = [];
  const calls: CallRecord[] = [];

  const wrapper = function (...args: Parameters<T>): ReturnType<T> {
    state.callCount++;
    calledWith.push(args);
    const record: CallRecord = { args, returnValue: undefined, threwError: false };
    try {
      const result = fn(...args) as ReturnType<T>;
      record.returnValue = result;
      returnValues.push(result);
      calls.push(record);
      return result;
    } catch (err) {
      record.threwError = true;
      record.error = err;
      calls.push(record);
      throw err;
    }
  } as SpyFn<T>;

  Object.defineProperty(wrapper, "callCount", { get: () => state.callCount });
  Object.defineProperty(wrapper, "calledWith", { get: () => calledWith });
  Object.defineProperty(wrapper, "returnValues", { get: () => returnValues });
  Object.defineProperty(wrapper, "calls", { get: () => calls });

  wrapper.restore = () => { /* no-op for plain spy - use mock() for object method replacement */ };
  wrapper.reset = () => {
    state.callCount = 0;
    calledWith.length = 0;
    returnValues.length = 0;
    calls.length = 0;
  };

  return wrapper;
}

/**
 * Creates a configurable stub function from scratch with no real implementation.
 */
export function stub<TReturn = unknown>(): StubFn<TReturn> {
  const state = { callCount: 0, sequenceIndex: 0, shouldThrow: false };
  const calledWith: unknown[][] = [];
  const returnValues: TReturn[] = [];
  const calls: CallRecord[] = [];
  let returnValue: TReturn | undefined = undefined;
  let sequence: TReturn[] | null = null;
  let throwValue: unknown = null;

  const wrapper = function (...args: unknown[]): TReturn {
    state.callCount++;
    calledWith.push(args);
    const record: CallRecord = { args, returnValue: undefined, threwError: false };

    if (state.shouldThrow) {
      record.threwError = true;
      record.error = throwValue;
      calls.push(record);
      throw throwValue;
    }

    let result: TReturn;
    if (sequence !== null) {
      result = sequence[Math.min(state.sequenceIndex++, sequence.length - 1)];
    } else {
      result = returnValue as TReturn;
    }

    record.returnValue = result;
    returnValues.push(result);
    calls.push(record);
    return result;
  } as StubFn<TReturn>;

  Object.defineProperty(wrapper, "callCount", { get: () => state.callCount });
  Object.defineProperty(wrapper, "calledWith", { get: () => calledWith });
  Object.defineProperty(wrapper, "returnValues", { get: () => returnValues });
  Object.defineProperty(wrapper, "calls", { get: () => calls });

  wrapper.returns = (value: TReturn): StubFn<TReturn> => {
    returnValue = value;
    sequence = null;
    state.shouldThrow = false;
    return wrapper;
  };

  wrapper.returnsSequence = (...values: TReturn[]): StubFn<TReturn> => {
    sequence = values;
    state.sequenceIndex = 0;
    state.shouldThrow = false;
    return wrapper;
  };

  wrapper.throws = (error: unknown): StubFn<TReturn> => {
    throwValue = error;
    state.shouldThrow = true;
    return wrapper;
  };

  wrapper.reset = () => {
    state.callCount = 0;
    state.sequenceIndex = 0;
    calledWith.length = 0;
    returnValues.length = 0;
    calls.length = 0;
  };

  return wrapper;
}

/**
 * Replaces obj[method] with a spy-wrapped version.
 * Returns tracking data and restore() to put the original method back.
 */
export function mock<TObj extends object, TKey extends keyof TObj>(
  obj: TObj,
  method: TKey
): MockRecord & { restore: () => void; reset: () => void } {
  const original = obj[method];
  if (typeof original !== "function") {
    throw new Error(`mock: property "${String(method)}" is not a function`);
  }

  const state = { callCount: 0 };
  const calledWith: unknown[][] = [];
  const returnValues: unknown[] = [];
  const calls: CallRecord[] = [];

  const replacement = function (this: unknown, ...args: unknown[]): unknown {
    state.callCount++;
    calledWith.push(args);
    const record: CallRecord = { args, returnValue: undefined, threwError: false };
    try {
      const result = (original as (...a: unknown[]) => unknown).apply(this, args);
      record.returnValue = result;
      returnValues.push(result);
      calls.push(record);
      return result;
    } catch (err) {
      record.threwError = true;
      record.error = err;
      calls.push(record);
      throw err;
    }
  };

  obj[method] = replacement as TObj[TKey];

  return {
    get callCount() { return state.callCount; },
    calledWith,
    returnValues,
    calls,
    restore() { obj[method] = original; },
    reset() {
      state.callCount = 0;
      calledWith.length = 0;
      returnValues.length = 0;
      calls.length = 0;
    },
  };
}
