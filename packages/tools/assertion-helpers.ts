/**
 * assertion-helpers.ts
 *
 * Debug-mode assertion utilities. All helpers are full no-ops in production
 * (NODE_ENV === "production") so they tree-shake cleanly and add zero runtime
 * cost to shipped builds.
 *
 * Usage:
 *   import { assert, assertNever, assertDefined, assertType, invariant } from "./assertion-helpers";
 */

const IS_PROD = process.env.NODE_ENV === "production";

// ---------------------------------------------------------------------------
// assert
// ---------------------------------------------------------------------------

/**
 * Asserts that a condition is truthy.
 * Throws an Error with `message` in development; no-ops in production.
 *
 * @param condition - Value that must be truthy.
 * @param message   - Human-readable failure description.
 *
 * @example
 * assert(items.length > 0, "items must not be empty");
 */
export function assert(condition: unknown, message: string): asserts condition {
  if (IS_PROD) return;
  if (!condition) {
    throw new Error(`[assert] ${message}`);
  }
}

// ---------------------------------------------------------------------------
// assertNever
// ---------------------------------------------------------------------------

/**
 * Exhaustiveness checker for discriminated unions.
 * TypeScript ensures this is called with `never` at compile time.
 * Throws at runtime in development if an unexpected branch is reached.
 *
 * @param x - The value that should be `never`.
 *
 * @example
 * switch (action.type) {
 *   case "a": return handleA();
 *   case "b": return handleB();
 *   default:  return assertNever(action.type);
 * }
 */
export function assertNever(x: never): never {
  if (IS_PROD) {
    // In production silently return to avoid crashing; the cast is safe
    // because the caller expects `never` but we preserve runtime stability.
    return undefined as never;
  }
  throw new Error(`[assertNever] Unhandled case: ${JSON.stringify(x)}`);
}

// ---------------------------------------------------------------------------
// assertDefined
// ---------------------------------------------------------------------------

/**
 * Asserts that a value is neither `null` nor `undefined`, and narrows the type.
 * No-op in production - the value is returned unchanged (possibly null/undefined).
 *
 * @param val     - Value to check.
 * @param message - Optional failure description (defaults to generic message).
 * @returns The value, narrowed to `NonNullable<T>`.
 *
 * @example
 * const el = assertDefined(document.getElementById("root"), "#root must exist");
 */
export function assertDefined<T>(
  val: T | null | undefined,
  message?: string
): NonNullable<T> {
  if (IS_PROD) return val as NonNullable<T>;
  if (val === null || val === undefined) {
    throw new Error(
      `[assertDefined] ${message ?? "Expected a defined value, got " + String(val)}`
    );
  }
  return val as NonNullable<T>;
}

// ---------------------------------------------------------------------------
// assertType
// ---------------------------------------------------------------------------

/**
 * Asserts that a value satisfies a type-guard predicate.
 * No-op in production - the value is cast without checking.
 *
 * @param val   - Value to check.
 * @param guard - Type-guard function `(v: unknown) => v is T`.
 * @param message - Optional failure description.
 * @returns The value, narrowed to `T`.
 *
 * @example
 * function isString(v: unknown): v is string { return typeof v === "string"; }
 * const name = assertType(raw, isString, "name must be a string");
 */
export function assertType<T>(
  val: unknown,
  guard: (v: unknown) => v is T,
  message?: string
): T {
  if (IS_PROD) return val as T;
  if (!guard(val)) {
    throw new Error(
      `[assertType] ${message ?? "Value failed type guard: " + JSON.stringify(val)}`
    );
  }
  return val;
}

// ---------------------------------------------------------------------------
// invariant
// ---------------------------------------------------------------------------

/**
 * Enforces a program invariant - a condition that must always hold.
 * Semantically identical to `assert` but signals stronger intent: this
 * condition is a correctness guarantee, not just a defensive check.
 * No-op in production.
 *
 * @param condition - Must be truthy for the invariant to hold.
 * @param msg       - Invariant description shown on failure.
 *
 * @example
 * invariant(queue.size >= 0, "queue size cannot be negative");
 */
export function invariant(condition: unknown, msg: string): asserts condition {
  if (IS_PROD) return;
  if (!condition) {
    throw new Error(`[invariant] Invariant violation: ${msg}`);
  }
}
