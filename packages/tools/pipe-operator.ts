/**
 * Functional pipe and compose utilities for data transformation chains.
 * pipe() - left to right composition
 * compose() - right to left composition
 * asyncPipe() - async-aware left to right composition
 * tap() - side effect passthrough
 */

// Sync pipe: value flows left to right through functions
export function pipe<A>(value: A): A;
export function pipe<A, B>(value: A, fn1: (a: A) => B): B;
export function pipe<A, B, C>(value: A, fn1: (a: A) => B, fn2: (b: B) => C): C;
export function pipe<A, B, C, D>(value: A, fn1: (a: A) => B, fn2: (b: B) => C, fn3: (c: C) => D): D;
export function pipe<A, B, C, D, E>(value: A, fn1: (a: A) => B, fn2: (b: B) => C, fn3: (c: C) => D, fn4: (d: D) => E): E;
export function pipe<A, B, C, D, E, F>(value: A, fn1: (a: A) => B, fn2: (b: B) => C, fn3: (c: C) => D, fn4: (d: D) => E, fn5: (e: E) => F): F;
export function pipe(value: unknown, ...fns: Array<(v: unknown) => unknown>): unknown {
  return fns.reduce((acc, fn) => fn(acc), value);
}

// Sync compose: functions applied right to left
export function compose<A>(fn1: (a: A) => A): (a: A) => A;
export function compose<A, B>(fn2: (b: B) => A, fn1: (a: A) => B): (a: A) => A;
export function compose<A, B, C>(fn3: (c: C) => B, fn2: (b: B) => C, fn1: (a: A) => B): (a: A) => B;
export function compose<A, B, C, D>(fn4: (d: D) => C, fn3: (c: C) => D, fn2: (b: B) => C, fn1: (a: A) => B): (a: A) => C;
export function compose(...fns: Array<(v: unknown) => unknown>): (value: unknown) => unknown {
  const reversed = [...fns].reverse();
  return (value: unknown) => reversed.reduce((acc, fn) => fn(acc), value);
}

// Async pipe: left to right, each step can be sync or async
export async function asyncPipe<A>(value: A): Promise<A>;
export async function asyncPipe<A, B>(value: A, fn1: (a: A) => B | Promise<B>): Promise<B>;
export async function asyncPipe<A, B, C>(value: A, fn1: (a: A) => B | Promise<B>, fn2: (b: B) => C | Promise<C>): Promise<C>;
export async function asyncPipe<A, B, C, D>(value: A, fn1: (a: A) => B | Promise<B>, fn2: (b: B) => C | Promise<C>, fn3: (c: C) => D | Promise<D>): Promise<D>;
export async function asyncPipe<A, B, C, D, E>(value: A, fn1: (a: A) => B | Promise<B>, fn2: (b: B) => C | Promise<C>, fn3: (c: C) => D | Promise<D>, fn4: (d: D) => E | Promise<E>): Promise<E>;
export async function asyncPipe(value: unknown, ...fns: Array<(v: unknown) => unknown | Promise<unknown>>): Promise<unknown> {
  let result = value;
  for (const fn of fns) {
    result = await fn(result);
  }
  return result;
}

// tap: run a side effect, pass value through unchanged
export function tap<T>(fn: (value: T) => void): (value: T) => T {
  return (value: T) => {
    fn(value);
    return value;
  };
}

// Async tap: await side effect, then pass value through
export function asyncTap<T>(fn: (value: T) => void | Promise<void>): (value: T) => Promise<T> {
  return async (value: T) => {
    await fn(value);
    return value;
  };
}

// branch: conditionally apply a transformation
export function branch<T>(
  predicate: (value: T) => boolean,
  ifTrue: (value: T) => T,
  ifFalse?: (value: T) => T
): (value: T) => T {
  return (value: T) => {
    if (predicate(value)) return ifTrue(value);
    return ifFalse ? ifFalse(value) : value;
  };
}

// Async branch: conditionally apply async transformations
export function asyncBranch<T>(
  predicate: (value: T) => boolean | Promise<boolean>,
  ifTrue: (value: T) => T | Promise<T>,
  ifFalse?: (value: T) => T | Promise<T>
): (value: T) => Promise<T> {
  return async (value: T) => {
    const condition = await predicate(value);
    if (condition) return ifTrue(value);
    return ifFalse ? ifFalse(value) : value;
  };
}
