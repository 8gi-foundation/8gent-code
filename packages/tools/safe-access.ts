/**
 * safe-access.ts
 *
 * Safely access, mutate, and inspect deeply nested object properties
 * without throwing on null/undefined intermediate values.
 *
 * All functions handle:
 * - null or undefined source objects
 * - missing intermediate keys
 * - non-object intermediate values
 * - empty paths
 */

type NestedObject = Record<string, unknown>;

/**
 * Parse a dot-notation path string into an array of keys.
 * Supports dot notation: "a.b.c" and array index notation: "a.0.b"
 */
function parsePath(path: string): string[] {
  if (!path) return [];
  return path.split(".");
}

/**
 * Safely retrieve a deeply nested value from an object.
 *
 * @param obj     - The source object (can be null/undefined)
 * @param path    - Dot-separated path string, e.g. "user.address.city"
 * @param defaultValue - Returned when the path cannot be resolved
 * @returns The value at the path, or defaultValue
 *
 * @example
 * safeGet({ user: { name: "James" } }, "user.name")  // "James"
 * safeGet({ user: null }, "user.name", "unknown")     // "unknown"
 * safeGet(null, "any.path", 42)                       // 42
 */
export function safeGet<T = unknown>(
  obj: unknown,
  path: string,
  defaultValue?: T
): T | undefined {
  if (obj == null || !path) return defaultValue;

  const keys = parsePath(path);
  let current: unknown = obj;

  for (const key of keys) {
    if (current == null || typeof current !== "object") {
      return defaultValue;
    }
    current = (current as NestedObject)[key];
  }

  return current === undefined ? defaultValue : (current as T);
}

/**
 * Safely set a deeply nested value on an object, creating intermediate
 * objects as needed. Does not mutate intermediate values that are
 * non-objects - those are replaced with a new object.
 *
 * @param obj   - The target object (must be a non-null object)
 * @param path  - Dot-separated path string, e.g. "user.address.city"
 * @param value - The value to set
 * @returns The same object reference (mutated in place)
 *
 * @example
 * safeSet({}, "user.address.city", "Dublin")
 * // { user: { address: { city: "Dublin" } } }
 */
export function safeSet<T extends NestedObject>(
  obj: T,
  path: string,
  value: unknown
): T {
  if (obj == null || typeof obj !== "object" || !path) return obj;

  const keys = parsePath(path);
  let current: NestedObject = obj as NestedObject;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const next = current[key];

    if (next == null || typeof next !== "object") {
      current[key] = {};
    }
    current = current[key] as NestedObject;
  }

  current[keys[keys.length - 1]] = value;
  return obj;
}

/**
 * Check whether a deeply nested path exists and is not undefined.
 *
 * @param obj  - The source object
 * @param path - Dot-separated path string
 * @returns true if the path resolves to a non-undefined value
 *
 * @example
 * safeHas({ user: { active: false } }, "user.active")  // true
 * safeHas({ user: {} }, "user.name")                   // false
 */
export function safeHas(obj: unknown, path: string): boolean {
  return safeGet(obj, path) !== undefined;
}

/**
 * Return a new object containing only the specified paths from the source.
 * Each path is resolved independently - missing paths are silently skipped.
 *
 * @param obj   - The source object
 * @param paths - Array of dot-separated path strings
 * @returns A new flat object with resolved path values
 *
 * @example
 * safePick({ a: 1, b: { c: 2 }, d: 3 }, ["a", "b.c"])
 * // { a: 1, "b.c": 2 }
 */
export function safePick(
  obj: unknown,
  paths: string[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const path of paths) {
    const value = safeGet(obj, path);
    if (value !== undefined) {
      result[path] = value;
    }
  }

  return result;
}

/**
 * Return a shallow clone of the top-level object with specified keys removed.
 * Only operates on top-level keys - does not support dot-notation for omit.
 *
 * @param obj  - The source object
 * @param keys - Array of top-level key names to omit
 * @returns A new object without the specified keys
 *
 * @example
 * safeOmit({ a: 1, b: 2, c: 3 }, ["b"])  // { a: 1, c: 3 }
 * safeOmit(null, ["a"])                   // {}
 */
export function safeOmit<T extends NestedObject>(
  obj: T | null | undefined,
  keys: string[]
): Partial<T> {
  if (obj == null || typeof obj !== "object") return {};

  const omitSet = new Set(keys);
  const result: Partial<T> = {};

  for (const key of Object.keys(obj)) {
    if (!omitSet.has(key)) {
      (result as NestedObject)[key] = (obj as NestedObject)[key];
    }
  }

  return result;
}
