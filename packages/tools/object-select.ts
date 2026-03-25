/**
 * Object field selection and transformation utilities.
 * Pure functions - no side effects, no dependencies.
 */

// ---------------------------------------------------------------------------
// select
// ---------------------------------------------------------------------------

/**
 * Picks a specific set of top-level keys from an object.
 * Keys that do not exist on the source are silently omitted.
 *
 * @example
 * select({ a: 1, b: 2, c: 3 }, ['a', 'c'])
 * // { a: 1, c: 3 }
 */
export function select<T extends object, K extends keyof T>(
  obj: T,
  fields: K[],
): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of fields) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      result[key] = obj[key];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// selectDeep
// ---------------------------------------------------------------------------

/**
 * Picks values at arbitrary dot-separated paths from a nested object.
 * Returns a flat record keyed by the full path string.
 * Missing intermediate nodes yield `undefined` for that path.
 *
 * @example
 * selectDeep({ user: { name: 'Alice', age: 30 }, id: 1 }, ['user.name', 'id'])
 * // { 'user.name': 'Alice', id: 1 }
 */
export function selectDeep(
  obj: Record<string, unknown>,
  paths: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const path of paths) {
    const parts = path.split('.');
    let cursor: unknown = obj;
    for (const part of parts) {
      if (cursor !== null && typeof cursor === 'object') {
        cursor = (cursor as Record<string, unknown>)[part];
      } else {
        cursor = undefined;
        break;
      }
    }
    result[path] = cursor;
  }
  return result;
}

// ---------------------------------------------------------------------------
// exclude
// ---------------------------------------------------------------------------

/**
 * Returns a shallow copy of the object with the specified keys removed.
 *
 * @example
 * exclude({ a: 1, b: 2, c: 3 }, ['b'])
 * // { a: 1, c: 3 }
 */
export function exclude<T extends object, K extends keyof T>(
  obj: T,
  fields: K[],
): Omit<T, K> {
  const excluded = new Set(fields as PropertyKey[]);
  const result = {} as Omit<T, K>;
  for (const key of Object.keys(obj) as Array<keyof T>) {
    if (!excluded.has(key as PropertyKey)) {
      (result as Record<PropertyKey, unknown>)[key as PropertyKey] = obj[key];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

/**
 * Renames keys according to a mapping of `{ oldKey: newKey }`.
 * Keys not in the map are copied unchanged. Values are not modified.
 *
 * @example
 * rename({ firstName: 'Alice', age: 30 }, { firstName: 'name' })
 * // { name: 'Alice', age: 30 }
 */
export function rename<T extends object>(
  obj: T,
  map: Partial<Record<keyof T, string>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj) as Array<keyof T>) {
    const newKey = (map[key] as string | undefined) ?? (key as string);
    result[newKey] = obj[key];
  }
  return result;
}

// ---------------------------------------------------------------------------
// mapKeys
// ---------------------------------------------------------------------------

/**
 * Returns a new object with every key transformed by `fn`.
 * If two keys produce the same output key, the last one wins.
 *
 * @example
 * mapKeys({ fooBar: 1, bazQux: 2 }, k => k.toLowerCase())
 * // { foobar: 1, bazqux: 2 }
 */
export function mapKeys<T extends object>(
  obj: T,
  fn: (key: string) => string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    result[fn(key)] = (obj as Record<string, unknown>)[key];
  }
  return result;
}

// ---------------------------------------------------------------------------
// mapValues
// ---------------------------------------------------------------------------

/**
 * Returns a new object with the same keys but every value transformed by `fn`.
 *
 * @example
 * mapValues({ a: 1, b: 2, c: 3 }, v => v * 2)
 * // { a: 2, b: 4, c: 6 }
 */
export function mapValues<T extends object, V>(
  obj: T,
  fn: (value: T[keyof T], key: string) => V,
): Record<string, V> {
  const result: Record<string, V> = {};
  for (const key of Object.keys(obj)) {
    result[key] = fn((obj as Record<string, T[keyof T]>)[key], key);
  }
  return result;
}
