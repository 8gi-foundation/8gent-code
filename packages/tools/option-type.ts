/**
 * Rust-style Option<T> for safe nullable value handling.
 * Replaces null/undefined checks with composable, type-safe operations.
 */

type SomeVariant<T> = {
  readonly _tag: "Some";
  readonly value: T;
};

type NoneVariant = {
  readonly _tag: "None";
};

export type Option<T> = SomeVariant<T> | NoneVariant;

/** Wraps a value in Some. */
export function Some<T>(value: T): Option<T> {
  return { _tag: "Some", value };
}

/** The None singleton - represents absence of a value. */
export const None: Option<never> = { _tag: "None" };

/** Returns true if the option contains a value. */
export function isSome<T>(opt: Option<T>): opt is SomeVariant<T> {
  return opt._tag === "Some";
}

/** Returns true if the option is empty. */
export function isNone<T>(opt: Option<T>): opt is NoneVariant {
  return opt._tag === "None";
}

/**
 * Constructs an Option from a nullable value.
 * null and undefined become None; everything else becomes Some.
 */
export function fromNullable<T>(value: T | null | undefined): Option<T> {
  return value == null ? None : Some(value);
}

/**
 * Transforms the inner value with fn if Some, propagates None otherwise.
 */
export function map<T, U>(opt: Option<T>, fn: (value: T) => U): Option<U> {
  return isSome(opt) ? Some(fn(opt.value)) : None;
}

/**
 * Chains Options - fn must return an Option.
 * Collapses nested Options (flatMap / andThen / bind).
 */
export function flatMap<T, U>(
  opt: Option<T>,
  fn: (value: T) => Option<U>
): Option<U> {
  return isSome(opt) ? fn(opt.value) : None;
}

/**
 * Returns the inner value or throws if None.
 * Use only when you are certain the value exists.
 */
export function unwrap<T>(opt: Option<T>): T {
  if (isSome(opt)) return opt.value;
  throw new Error("Called unwrap on a None value");
}

/**
 * Returns the inner value or the provided default.
 */
export function unwrapOr<T>(opt: Option<T>, defaultValue: T): T {
  return isSome(opt) ? opt.value : defaultValue;
}

/**
 * Keeps Some(value) only if predicate returns true; collapses to None otherwise.
 */
export function filter<T>(
  opt: Option<T>,
  predicate: (value: T) => boolean
): Option<T> {
  if (isSome(opt) && predicate(opt.value)) return opt;
  return None;
}

/**
 * Pattern match over an Option.
 * Executes `some(value)` if Some, or `none()` if None.
 */
export function match<T, R>(
  opt: Option<T>,
  cases: { some: (value: T) => R; none: () => R }
): R {
  return isSome(opt) ? cases.some(opt.value) : cases.none();
}

/**
 * Combines two Options into a tuple.
 * Returns None if either is None.
 */
export function zip<A, B>(a: Option<A>, b: Option<B>): Option<[A, B]> {
  if (isSome(a) && isSome(b)) return Some([a.value, b.value]);
  return None;
}

/**
 * Converts an Option to a nullable value (Some(x) -> x, None -> null).
 */
export function toNullable<T>(opt: Option<T>): T | null {
  return isSome(opt) ? opt.value : null;
}

/**
 * Returns the first Some from a list of Options, or None if all are None.
 */
export function firstSome<T>(...opts: Option<T>[]): Option<T> {
  for (const opt of opts) {
    if (isSome(opt)) return opt;
  }
  return None;
}
