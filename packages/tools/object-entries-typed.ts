/**
 * Typed Object.entries/keys/values/fromEntries helpers.
 *
 * TypeScript's built-in Object.entries/keys/values return `string[]` or
 * `[string, T][]`, discarding the literal key union. These helpers preserve
 * it so callers get full type narrowing without casting.
 */

// ---------------------------------------------------------------------------
// Core typed wrappers
// ---------------------------------------------------------------------------

/** Object.keys with the key union preserved. */
export function typedKeys<T extends object>(obj: T): (keyof T)[] {
  return Object.keys(obj) as (keyof T)[];
}

/** Object.values with value type preserved. */
export function typedValues<T extends object>(obj: T): T[keyof T][] {
  return Object.values(obj) as T[keyof T][];
}

/** Object.entries with key union and value type preserved. */
export function typedEntries<T extends object>(
  obj: T,
): [keyof T, T[keyof T]][] {
  return Object.entries(obj) as [keyof T, T[keyof T]][];
}

/**
 * Typed Object.fromEntries.
 * Reconstructs an object from a list of [key, value] pairs.
 */
export function typedFromEntries<K extends PropertyKey, V>(
  entries: Iterable<readonly [K, V]>,
): Record<K, V> {
  return Object.fromEntries(entries) as Record<K, V>;
}

// ---------------------------------------------------------------------------
// Transformation helpers
// ---------------------------------------------------------------------------

/**
 * Map over an object's values, producing a new object with the same keys.
 *
 * @example
 *   mapObject({ a: 1, b: 2 }, (v) => v * 2) // { a: 2, b: 4 }
 */
export function mapObject<T extends object, U>(
  obj: T,
  fn: (value: T[keyof T], key: keyof T) => U,
): Record<keyof T, U> {
  const result = {} as Record<keyof T, U>;
  for (const [key, value] of typedEntries(obj)) {
    result[key] = fn(value, key);
  }
  return result;
}

/**
 * Filter an object's entries by a predicate.
 * Returns a new object containing only the entries where predicate returns true.
 *
 * @example
 *   filterObject({ a: 1, b: 2, c: 3 }, (v) => v > 1) // { b: 2, c: 3 }
 */
export function filterObject<T extends object>(
  obj: T,
  pred: (value: T[keyof T], key: keyof T) => boolean,
): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of typedEntries(obj)) {
    if (pred(value, key)) {
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pick / omit
// ---------------------------------------------------------------------------

/**
 * Pick a subset of keys from an object.
 * Equivalent to TypeScript's Pick<T, K> at runtime.
 *
 * @example
 *   pickKeys({ a: 1, b: 2, c: 3 }, ['a', 'c']) // { a: 1, c: 3 }
 */
export function pickKeys<T extends object, K extends keyof T>(
  obj: T,
  keys: readonly K[],
): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      result[key] = obj[key];
    }
  }
  return result;
}

/**
 * Omit a subset of keys from an object.
 * Equivalent to TypeScript's Omit<T, K> at runtime.
 *
 * @example
 *   omitKeys({ a: 1, b: 2, c: 3 }, ['b']) // { a: 1, c: 3 }
 */
export function omitKeys<T extends object, K extends keyof T>(
  obj: T,
  keys: readonly K[],
): Omit<T, K> {
  const keySet = new Set<PropertyKey>(keys);
  const result = {} as Omit<T, K>;
  for (const [key, value] of typedEntries(obj)) {
    if (!keySet.has(key as PropertyKey)) {
      (result as Record<PropertyKey, unknown>)[key as PropertyKey] = value;
    }
  }
  return result;
}
