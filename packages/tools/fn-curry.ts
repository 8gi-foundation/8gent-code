/**
 * fn-curry.ts
 *
 * Function currying and partial application utilities for functional composition.
 *
 * Exports: curry, partial, partialRight, flip, negate
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

type Curried<F extends AnyFn> = F extends (...args: infer A) => infer R
  ? A extends [infer _First, ...infer Rest]
    ? Rest extends []
      ? F
      : (arg: A[0]) => Curried<(...args: Rest) => R>
    : F
  : never;

// ---------------------------------------------------------------------------
// curry
// ---------------------------------------------------------------------------

/**
 * Auto-curry a function of fixed arity.
 *
 * Returns a curried version of fn. Accumulates arguments until the
 * original function's length is satisfied, then invokes it.
 *
 * @example
 *   const add = curry((a: number, b: number) => a + b);
 *   add(1)(2); // 3
 *   add(1, 2); // 3
 */
export function curry<F extends AnyFn>(fn: F): Curried<F> {
  const arity = fn.length;

  function curried(...args: unknown[]): unknown {
    if (args.length >= arity) {
      return fn(...args);
    }
    return (...more: unknown[]) => curried(...args, ...more);
  }

  return curried as Curried<F>;
}

// ---------------------------------------------------------------------------
// partial
// ---------------------------------------------------------------------------

/**
 * Partially apply arguments from the left.
 *
 * Returns a new function with the provided leading arguments pre-filled.
 *
 * @example
 *   const multiply = (a: number, b: number) => a * b;
 *   const double = partial(multiply, 2);
 *   double(5); // 10
 */
export function partial<F extends AnyFn>(
  fn: F,
  ...preArgs: Partial<Parameters<F>>
): (...args: unknown[]) => ReturnType<F> {
  return (...laterArgs: unknown[]): ReturnType<F> =>
    fn(...preArgs, ...laterArgs);
}

// ---------------------------------------------------------------------------
// partialRight
// ---------------------------------------------------------------------------

/**
 * Partially apply arguments from the right.
 *
 * Returns a new function with the provided trailing arguments pre-filled.
 *
 * @example
 *   const divide = (a: number, b: number) => a / b;
 *   const halve = partialRight(divide, 2);
 *   halve(10); // 5
 */
export function partialRight<F extends AnyFn>(
  fn: F,
  ...tailArgs: Partial<Parameters<F>>
): (...args: unknown[]) => ReturnType<F> {
  return (...leadArgs: unknown[]): ReturnType<F> =>
    fn(...leadArgs, ...tailArgs);
}

// ---------------------------------------------------------------------------
// flip
// ---------------------------------------------------------------------------

/**
 * Return a new function with its first two arguments swapped.
 *
 * Useful when adapting a function to an API that supplies arguments in the
 * opposite order (e.g. passing it as a comparator or callback).
 *
 * @example
 *   const sub = (a: number, b: number) => a - b;
 *   const rsub = flip(sub);
 *   rsub(3, 10); // 10 - 3 = 7
 */
export function flip<F extends AnyFn>(fn: F): F {
  return ((...args: Parameters<F>): ReturnType<F> => {
    const [first, second, ...rest] = args;
    return fn(second, first, ...rest);
  }) as F;
}

// ---------------------------------------------------------------------------
// negate
// ---------------------------------------------------------------------------

/**
 * Return a predicate that is the boolean negation of fn.
 *
 * @example
 *   const isEven = (n: number) => n % 2 === 0;
 *   const isOdd = negate(isEven);
 *   [1, 2, 3, 4].filter(isOdd); // [1, 3]
 */
export function negate<F extends (...args: Parameters<F>) => boolean>(
  fn: F,
): (...args: Parameters<F>) => boolean {
  return (...args: Parameters<F>): boolean => !fn(...args);
}
