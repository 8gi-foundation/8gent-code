/**
 * safe-stringify
 *
 * JSON.stringify that handles circular references and special types without
 * throwing. Drop-in for JSON.stringify with extra options.
 *
 * Handles: circular refs, BigInt, undefined, Error, RegExp, Date, Map, Set,
 *          functions, Symbol, Infinity, NaN.
 */

export interface SafeStringifyOptions {
  /** Standard JSON.stringify replacer (applied before type handling). */
  replacer?: ((key: string, value: unknown) => unknown) | null;
  /** Indentation spaces or string (passed to JSON.stringify). */
  space?: number | string;
  /**
   * Maximum nesting depth before values are replaced with [MaxDepth].
   * Defaults to 50. Set to 0 to disable.
   */
  maxDepth?: number;
}

type SerializedSpecial =
  | { __type: "BigInt"; value: string }
  | { __type: "undefined" }
  | { __type: "function"; name: string }
  | { __type: "symbol"; value: string }
  | { __type: "Error"; name: string; message: string; stack?: string }
  | { __type: "RegExp"; source: string; flags: string }
  | { __type: "Map"; entries: [unknown, unknown][] }
  | { __type: "Set"; values: unknown[] }
  | "[Circular]"
  | "[MaxDepth]"
  | "[Infinity]"
  | "[-Infinity]"
  | "[NaN]";

function serializeValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  maxDepth: number,
  userReplacer: SafeStringifyOptions["replacer"],
  key: string
): unknown {
  // Apply user replacer first (matches JSON.stringify semantics).
  if (userReplacer != null) {
    value = userReplacer(key, value);
  }

  if (value === undefined) {
    return { __type: "undefined" } satisfies SerializedSpecial;
  }

  if (typeof value === "bigint") {
    return { __type: "BigInt", value: value.toString() } satisfies SerializedSpecial;
  }

  if (typeof value === "function") {
    return { __type: "function", name: value.name || "(anonymous)" } satisfies SerializedSpecial;
  }

  if (typeof value === "symbol") {
    return { __type: "symbol", value: value.toString() } satisfies SerializedSpecial;
  }

  if (typeof value === "number") {
    if (Number.isNaN(value)) return "[NaN]" satisfies SerializedSpecial;
    if (value === Infinity) return "[Infinity]" satisfies SerializedSpecial;
    if (value === -Infinity) return "[-Infinity]" satisfies SerializedSpecial;
    return value;
  }

  // Primitives that JSON handles natively.
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }

  // Everything below is an object.
  const obj = value as object;

  if (seen.has(obj)) {
    return "[Circular]" satisfies SerializedSpecial;
  }

  if (maxDepth > 0 && depth >= maxDepth) {
    return "[MaxDepth]" satisfies SerializedSpecial;
  }

  if (value instanceof Error) {
    return {
      __type: "Error",
      name: value.name,
      message: value.message,
      stack: value.stack,
    } satisfies SerializedSpecial;
  }

  if (value instanceof RegExp) {
    return {
      __type: "RegExp",
      source: value.source,
      flags: value.flags,
    } satisfies SerializedSpecial;
  }

  // Date - let JSON.stringify handle it natively (toISOString).
  if (value instanceof Date) {
    return value;
  }

  seen.add(obj);

  if (value instanceof Map) {
    const entries: [unknown, unknown][] = [];
    for (const [k, v] of value) {
      entries.push([
        serializeValue(k, seen, depth + 1, maxDepth, userReplacer, ""),
        serializeValue(v, seen, depth + 1, maxDepth, userReplacer, ""),
      ]);
    }
    seen.delete(obj);
    return { __type: "Map", entries } satisfies SerializedSpecial;
  }

  if (value instanceof Set) {
    const values: unknown[] = [];
    for (const v of value) {
      values.push(serializeValue(v, seen, depth + 1, maxDepth, userReplacer, ""));
    }
    seen.delete(obj);
    return { __type: "Set", values } satisfies SerializedSpecial;
  }

  if (Array.isArray(value)) {
    const arr = value.map((item, i) =>
      serializeValue(item, seen, depth + 1, maxDepth, userReplacer, String(i))
    );
    seen.delete(obj);
    return arr;
  }

  // Plain object.
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = serializeValue(v, seen, depth + 1, maxDepth, userReplacer, k);
  }
  seen.delete(obj);
  return result;
}

/**
 * Safely serialize `value` to a JSON string.
 *
 * Handles circular references (replaced with `"[Circular]"`), BigInt, Error,
 * RegExp, Map, Set, undefined, functions, symbols, NaN, and Infinity.
 *
 * Returns `undefined` only if `value` is a top-level function or symbol (same
 * behaviour as native JSON.stringify).
 */
export function safeStringify(value: unknown, options: SafeStringifyOptions = {}): string {
  const { replacer = null, space, maxDepth = 50 } = options;

  const seen = new WeakSet<object>();

  const safe = serializeValue(value, seen, 0, maxDepth, replacer, "");

  return JSON.stringify(safe, null, space);
}
