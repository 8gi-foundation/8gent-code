/**
 * type-check.ts
 * Comprehensive runtime type checking with detailed error messages.
 */

/**
 * Returns a detailed type string for any value, going beyond typeof.
 */
export function typeOf(val: unknown): string {
  if (val === null) return "null";
  if (val === undefined) return "undefined";

  const tag = Object.prototype.toString.call(val);

  switch (tag) {
    case "[object String]": return "string";
    case "[object Number]": return Number.isNaN(val as number) ? "NaN" : "number";
    case "[object Boolean]": return "boolean";
    case "[object Array]": return "array";
    case "[object Function]": return "function";
    case "[object AsyncFunction]": return "asyncfunction";
    case "[object GeneratorFunction]": return "generatorfunction";
    case "[object Date]": return "date";
    case "[object RegExp]": return "regex";
    case "[object Promise]": return "promise";
    case "[object Error]":
    case "[object EvalError]":
    case "[object RangeError]":
    case "[object ReferenceError]":
    case "[object SyntaxError]":
    case "[object TypeError]":
    case "[object URIError]":
      return "error";
    case "[object Map]": return "map";
    case "[object Set]": return "set";
    case "[object WeakMap]": return "weakmap";
    case "[object WeakSet]": return "weakset";
    case "[object Symbol]": return "symbol";
    case "[object BigInt]": return "bigint";
    case "[object ArrayBuffer]": return "arraybuffer";
    case "[object Object]": return "object";
    default:
      return tag.replace(/^\[object /, "").replace(/]$/, "").toLowerCase();
  }
}

/**
 * Type guard helpers.
 */
export const is = {
  string: (val: unknown): val is string => typeOf(val) === "string",
  number: (val: unknown): val is number => typeOf(val) === "number",
  boolean: (val: unknown): val is boolean => typeOf(val) === "boolean",
  array: (val: unknown): val is unknown[] => typeOf(val) === "array",
  object: (val: unknown): val is Record<string, unknown> =>
    typeOf(val) === "object",
  function: (val: unknown): val is (...args: unknown[]) => unknown =>
    typeOf(val) === "function" || typeOf(val) === "asyncfunction",
  null: (val: unknown): val is null => val === null,
  undefined: (val: unknown): val is undefined => val === undefined,
  nullish: (val: unknown): val is null | undefined =>
    val === null || val === undefined,
  date: (val: unknown): val is Date =>
    typeOf(val) === "date" && !isNaN((val as Date).getTime()),
  regex: (val: unknown): val is RegExp => typeOf(val) === "regex",
  promise: (val: unknown): val is Promise<unknown> =>
    typeOf(val) === "promise" ||
    (val !== null &&
      typeof val === "object" &&
      typeof (val as Record<string, unknown>).then === "function"),
  error: (val: unknown): val is Error => val instanceof Error,
  map: (val: unknown): val is Map<unknown, unknown> => val instanceof Map,
  set: (val: unknown): val is Set<unknown> => val instanceof Set,
  symbol: (val: unknown): val is symbol => typeof val === "symbol",
  bigint: (val: unknown): val is bigint => typeof val === "bigint",
  nan: (val: unknown): val is number =>
    typeof val === "number" && isNaN(val),
  integer: (val: unknown): val is number =>
    is.number(val) && Number.isInteger(val as number),
  finite: (val: unknown): val is number =>
    is.number(val) && Number.isFinite(val as number),
  primitive: (val: unknown): val is string | number | boolean | null | undefined | symbol | bigint =>
    val === null || !["object", "function"].includes(typeof val),
};

/**
 * Asserts that val matches the expected type string (as returned by typeOf).
 * Throws a TypeError with a detailed message if the check fails.
 *
 * @example
 *   assertType(42, "number");           // passes
 *   assertType("hello", "number");      // throws: expected number, got string
 *   assertType(null, "null");           // passes
 */
export function assertType(
  val: unknown,
  expected: string,
  label?: string
): void {
  const actual = typeOf(val);
  if (actual !== expected) {
    const name = label ? `"${label}"` : "value";
    throw new TypeError(
      `Type assertion failed for ${name}: expected ${expected}, got ${actual} (${JSON.stringify(val)})`
    );
  }
}

/**
 * Soft version - returns true/false instead of throwing.
 */
export function checkType(val: unknown, expected: string): boolean {
  return typeOf(val) === expected;
}
