/**
 * Get the enum value from a string.
 * @param enumObj - The enum object.
 * @param str - The string to match.
 * @returns The corresponding enum value or undefined.
 */
function fromString<T>(enumObj: any, str: string): T | undefined {
  for (const key of Object.keys(enumObj)) {
    const value = enumObj[key];
    if (value === str) {
      return value as T;
    }
  }
  return undefined;
}

/**
 * Get an array of enum values.
 * @param enumObj - The enum object.
 * @returns Array of enum values.
 */
function values<T>(enumObj: any): T[] {
  return Object.values(enumObj) as T[];
}

/**
 * Get an array of enum keys.
 * @param enumObj - The enum object.
 * @returns Array of enum keys.
 */
function keys(enumObj: any): string[] {
  return Object.keys(enumObj);
}

/**
 * Check if a value is a valid enum value.
 * @param enumObj - The enum object.
 * @param val - The value to check.
 * @returns True if the value is a valid enum value.
 */
function isEnumValue<T>(enumObj: any, val: any): val is T {
  return Object.values(enumObj).includes(val);
}

/**
 * Parse a string to an enum value, throwing if invalid.
 * @param enumObj - The enum object.
 * @param str - The string to parse.
 * @returns The corresponding enum value.
 * @throws Error if the string is not a valid enum value.
 */
function parseEnum<T>(enumObj: any, str: string): T {
  const result = fromString(enumObj, str);
  if (result === undefined) {
    throw new Error(`Invalid value: ${str}`);
  }
  return result;
}

export { fromString, values, keys, isEnumValue, parseEnum };