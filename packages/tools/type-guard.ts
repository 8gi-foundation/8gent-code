/**
 * Checks if the value is a string.
 * @param val - The value to check.
 * @returns True if val is a string.
 */
export function isString(val: any): boolean {
  return typeof val === 'string';
}

/**
 * Checks if the value is a number.
 * @param val - The value to check.
 * @returns True if val is a number.
 */
export function isNumber(val: any): boolean {
  return typeof val === 'number';
}

/**
 * Checks if the value is a boolean.
 * @param val - The value to check.
 * @returns True if val is a boolean.
 */
export function isBoolean(val: any): boolean {
  return typeof val === 'boolean';
}

/**
 * Checks if the value is null.
 * @param val - The value to check.
 * @returns True if val is null.
 */
export function isNull(val: any): boolean {
  return val === null;
}

/**
 * Checks if the value is undefined.
 * @param val - The value to check.
 * @returns True if val is undefined.
 */
export function isUndefined(val: any): boolean {
  return val === undefined;
}

/**
 * Checks if the value is an array.
 * @param val - The value to check.
 * @returns True if val is an array.
 */
export function isArray(val: any): boolean {
  return Array.isArray(val);
}

/**
 * Checks if the value is an object.
 * @param val - The value to check.
 * @returns True if val is an object.
 */
export function isObject(val: any): boolean {
  return typeof val === 'object' && val !== null;
}

/**
 * Checks if the value is non-null and non-undefined.
 * @param val - The value to check.
 * @returns True if val is non-null and non-undefined.
 */
export function isNonNull<T>(val: T): val is NonNullable<T> {
  return val !== null && val !== undefined;
}

/**
 * Throws an error if the condition is false.
 * @param condition - The condition to check.
 * @param message - The error message.
 */
export function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * Throws an error if the value is null or undefined.
 * @param val - The value to check.
 * @param message - The error message.
 */
export function assertNonNull<T>(val: T, message: string): void {
  assert(isNonNull(val), message);
}

/**
 * Checks if the value is a record (object with string keys).
 * @param val - The value to check.
 * @returns True if val is a record.
 */
export function isRecord(val: any): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}