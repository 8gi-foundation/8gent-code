/**
 * Composable type predicate builders.
 *
 * Usage:
 *   is.string("hello")                          // true
 *   is.arrayOf(is.string)(["a", "b"])           // true
 *   is.objectOf({ name: is.string })({ name: "Eight" }) // true
 *   is.union(is.string, is.number)("hi")        // true
 *   is.optional(is.string)(undefined)           // true
 *   is.tuple(is.string, is.number)(["hi", 1])  // true
 */

export type Predicate<T> = (value: unknown) => value is T;

function string(value: unknown): value is string {
  return typeof value === "string";
}

function number(value: unknown): value is number {
  return typeof value === "number" && !Number.isNaN(value);
}

function boolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function bigint(value: unknown): value is bigint {
  return typeof value === "bigint";
}

function symbol(value: unknown): value is symbol {
  return typeof value === "symbol";
}

function nil(value: unknown): value is null {
  return value === null;
}

function undef(value: unknown): value is undefined {
  return value === undefined;
}

function func(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

// --- Combinators ---

function arrayOf<T>(predicate: Predicate<T>): Predicate<T[]> {
  return (value: unknown): value is T[] =>
    Array.isArray(value) && value.every(predicate);
}

type ObjectShape = Record<string, Predicate<unknown>>;
type InferObject<S extends ObjectShape> = {
  [K in keyof S]: S[K] extends Predicate<infer T> ? T : never;
};

function objectOf<S extends ObjectShape>(shape: S): Predicate<InferObject<S>> {
  return (value: unknown): value is InferObject<S> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(shape)) {
      if (!shape[key](obj[key])) return false;
    }
    return true;
  };
}

function union<A, B>(a: Predicate<A>, b: Predicate<B>): Predicate<A | B>;
function union<A, B, C>(
  a: Predicate<A>,
  b: Predicate<B>,
  c: Predicate<C>
): Predicate<A | B | C>;
function union(...predicates: Predicate<unknown>[]): Predicate<unknown> {
  return (value: unknown): value is unknown =>
    predicates.some((p) => p(value));
}

function optional<T>(predicate: Predicate<T>): Predicate<T | undefined> {
  return (value: unknown): value is T | undefined =>
    value === undefined || predicate(value);
}

function nullable<T>(predicate: Predicate<T>): Predicate<T | null> {
  return (value: unknown): value is T | null =>
    value === null || predicate(value);
}

type InferTuple<T extends Predicate<unknown>[]> = {
  [K in keyof T]: T[K] extends Predicate<infer U> ? U : never;
};

function tuple<T extends Predicate<unknown>[]>(
  ...predicates: T
): Predicate<InferTuple<T>> {
  return (value: unknown): value is InferTuple<T> => {
    if (!Array.isArray(value) || value.length !== predicates.length) {
      return false;
    }
    return predicates.every((p, i) => p(value[i]));
  };
}

function literal<T extends string | number | boolean>(
  expected: T
): Predicate<T> {
  return (value: unknown): value is T => value === expected;
}

export const is = {
  string,
  number,
  boolean,
  bigint,
  symbol,
  null: nil,
  undefined: undef,
  function: func,
  object,
  array,
  arrayOf,
  objectOf,
  union,
  optional,
  nullable,
  tuple,
  literal,
};
