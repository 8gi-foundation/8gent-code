/**
 * Function composition utilities.
 *
 * flow(fn1, fn2, fn3)  - left-to-right: fn1 result feeds fn2, then fn3
 * compose(fn1, fn2, fn3) - right-to-left: fn3 runs first, then fn2, then fn1
 * flowAsync / composeAsync - same semantics, awaits each step
 * identity(x) - returns x unchanged
 * constant(x) - returns a function that always returns x
 */

// ---------------------------------------------------------------------------
// Sync composition
// ---------------------------------------------------------------------------

/** Left-to-right function composition (pipeline). */
export function flow(...fns: Array<(x: unknown) => unknown>) {
  if (fns.length === 0) return identity;
  return (input: unknown) => fns.reduce((acc, fn) => fn(acc), input);
}

/** Right-to-left function composition (mathematical convention). */
export function compose(...fns: Array<(x: unknown) => unknown>) {
  if (fns.length === 0) return identity;
  return flow(...([...fns].reverse() as [typeof fns[0]]));
}

// ---------------------------------------------------------------------------
// Async composition
// ---------------------------------------------------------------------------

type AsyncFn<A, B> = (a: A) => Promise<B> | B;

/** Left-to-right async pipeline. Each step is awaited before the next. */
export function flowAsync(...fns: Array<AsyncFn<unknown, unknown>>) {
  if (fns.length === 0) return (x: unknown) => Promise.resolve(x);
  return async (input: unknown) => {
    let acc = input;
    for (const fn of fns) acc = await fn(acc);
    return acc;
  };
}

/** Right-to-left async composition. */
export function composeAsync(...fns: Array<AsyncFn<unknown, unknown>>) {
  return flowAsync(...([...fns].reverse() as [typeof fns[0]]));
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** Returns the argument unchanged. Useful as a default no-op function. */
export function identity<T>(x: T): T {
  return x;
}

/** Returns a function that always returns the given value regardless of input. */
export function constant<T>(x: T): () => T {
  return () => x;
}
