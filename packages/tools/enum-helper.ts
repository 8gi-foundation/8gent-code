/**
 * enum-helper - utilities for working with TypeScript string enums.
 *
 * TypeScript string enums are verbose and lack runtime helpers. This module
 * provides a minimal, type-safe API for creation, iteration, type-guarding,
 * and parsing of string enum-like objects.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A const object whose values are all strings - the runtime shape of a TS string enum. */
export type StringEnumObject<K extends string = string, V extends string = string> = {
  readonly [key in K]: V;
};

/** Union of all values in a StringEnumObject. */
export type EnumValues<T extends StringEnumObject> = T[keyof T];

/** Union of all keys in a StringEnumObject. */
export type EnumKeys<T extends StringEnumObject> = keyof T & string;

// ---------------------------------------------------------------------------
// createEnum
// ---------------------------------------------------------------------------

/**
 * Create a frozen const object from an array of string values where each key
 * equals its value. This mirrors how TypeScript string enums behave at runtime.
 *
 * @example
 * const Color = createEnum(['red', 'green', 'blue']);
 * // { red: 'red', green: 'green', blue: 'blue' }
 */
export function createEnum<const T extends readonly string[]>(
  values: T,
): { readonly [K in T[number]]: K } {
  const obj = {} as { [K in T[number]]: K };
  for (const value of values) {
    (obj as Record<string, string>)[value] = value;
  }
  return Object.freeze(obj);
}

// ---------------------------------------------------------------------------
// enumValues
// ---------------------------------------------------------------------------

/**
 * Return all values of a string enum object as an array.
 *
 * @example
 * const Color = createEnum(['red', 'green', 'blue']);
 * enumValues(Color); // ['red', 'green', 'blue']
 */
export function enumValues<T extends StringEnumObject>(enumObj: T): Array<T[keyof T]> {
  return Object.values(enumObj) as Array<T[keyof T]>;
}

// ---------------------------------------------------------------------------
// enumKeys
// ---------------------------------------------------------------------------

/**
 * Return all keys of a string enum object as an array.
 *
 * @example
 * const Color = createEnum(['red', 'green', 'blue']);
 * enumKeys(Color); // ['red', 'green', 'blue']
 */
export function enumKeys<T extends StringEnumObject>(enumObj: T): Array<keyof T & string> {
  return Object.keys(enumObj) as Array<keyof T & string>;
}

// ---------------------------------------------------------------------------
// isEnumValue
// ---------------------------------------------------------------------------

/**
 * Type guard that checks whether a given value is a valid value of the enum.
 *
 * @example
 * const Color = createEnum(['red', 'green', 'blue']);
 * isEnumValue(Color, 'red');   // true
 * isEnumValue(Color, 'purple'); // false
 */
export function isEnumValue<T extends StringEnumObject>(
  enumObj: T,
  val: unknown,
): val is T[keyof T] {
  return typeof val === 'string' && Object.values(enumObj).includes(val);
}

// ---------------------------------------------------------------------------
// enumFromString
// ---------------------------------------------------------------------------

/**
 * Parse a string into a valid enum value, returning a fallback when the string
 * does not match any value. Case-sensitive by default.
 *
 * @example
 * const Color = createEnum(['red', 'green', 'blue']);
 * enumFromString(Color, 'green');         // 'green'
 * enumFromString(Color, 'purple', 'red'); // 'red' (fallback)
 * enumFromString(Color, 'GREEN', 'red', { caseInsensitive: true }); // 'green'
 */
export function enumFromString<T extends StringEnumObject>(
  enumObj: T,
  str: string,
  fallback: T[keyof T],
  options: { caseInsensitive?: boolean } = {},
): T[keyof T] {
  const values = Object.values(enumObj) as string[];

  if (options.caseInsensitive) {
    const lower = str.toLowerCase();
    const match = values.find((v) => v.toLowerCase() === lower);
    return (match as T[keyof T] | undefined) ?? fallback;
  }

  return (values.includes(str) ? (str as T[keyof T]) : fallback);
}
