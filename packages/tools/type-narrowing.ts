/**
 * Runtime type narrowing utilities for unknown values.
 * All functions are proper TypeScript type guards with full inference support.
 */

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number" && !Number.isNaN(value);
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function isTypedArray<T>(
  value: unknown,
  guard: (item: unknown) => item is T
): value is T[] {
  return Array.isArray(value) && value.every(guard);
}

export function isObject(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Error) &&
    !(value instanceof Promise)
  );
}

export function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

export function isDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export function isError(value: unknown): value is Error {
  return value instanceof Error;
}

export function isPromise(value: unknown): value is Promise<unknown> {
  return (
    value instanceof Promise ||
    (isObject(value) && isFunction((value as Record<string, unknown>).then))
  );
}

export function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

export function isNonNullable<T>(value: T): value is NonNullable<T> {
  return value !== null && value !== undefined;
}

/**
 * Asserts that a value matches a type guard, throwing a TypeError if not.
 * Useful for runtime validation at trust boundaries.
 *
 * @example
 * assertType(value, isString, "name"); // throws TypeError: Expected name to be string
 */
export function assertType<T>(
  value: unknown,
  guard: (v: unknown) => v is T,
  label = "value"
): asserts value is T {
  if (!guard(value)) {
    const expected = guard.name.replace(/^is/, "").toLowerCase();
    throw new TypeError(
      `Expected ${label} to be ${expected}, got ${typeof value}`
    );
  }
}

/**
 * Narrows a value within a conditional branch without throwing.
 * Returns the value typed as T if the guard passes, otherwise undefined.
 *
 * @example
 * const n = narrow(input, isNumber);
 * if (n !== undefined) console.log(n.toFixed(2));
 */
export function narrow<T>(
  value: unknown,
  guard: (v: unknown) => v is T
): T | undefined {
  return guard(value) ? value : undefined;
}

/**
 * Picks a specific key from an unknown object after validating it is an object.
 * Returns undefined if the value is not an object or the key is absent.
 */
export function pickKey<T>(
  value: unknown,
  key: string,
  guard: (v: unknown) => v is T
): T | undefined {
  if (!isObject(value)) return undefined;
  return narrow(value[key], guard);
}

/**
 * Combines multiple type guards into a union guard.
 *
 * @example
 * const isStringOrNumber = oneOf(isString, isNumber);
 */
export function oneOf<T extends unknown[]>(
  ...guards: { [K in keyof T]: (v: unknown) => v is T[K] }
): (v: unknown) => v is T[number] {
  return (v: unknown): v is T[number] => guards.some((g) => g(v));
}
