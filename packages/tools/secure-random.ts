import * as crypto from 'crypto';

/**
 * Generates a cryptographically secure random hex string.
 * @param byteLength - Length of the random byte string.
 * @returns Hex string.
 */
export function token(byteLength: number): string {
  return crypto.randomBytes(byteLength).toString('hex');
}

/**
 * Generates a cryptographically secure random password.
 * @param length - Length of the password.
 * @param options - Charset configuration.
 * @returns Random password.
 */
export function password(length: number, options?: { includeUppercase?: boolean, includeLowercase?: boolean, includeDigits?: boolean, includeSymbols?: boolean }): string {
  const defaultCharset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+~`|}{[]:;?><,./-=';
  let charset = '';
  if (options?.includeUppercase ?? true) charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (options?.includeLowercase ?? true) charset += 'abcdefghijklmnopqrstuvwxyz';
  if (options?.includeDigits ?? true) charset += '0123456789';
  if (options?.includeSymbols ?? true) charset += '!@#$%^&*()_+~`|}{[]:;?><,./-=';

  let result = '';
  for (let i = 0; i < length; i++) {
    const index = crypto.randomInt(charset.length);
    result += charset[index];
  }
  return result;
}

/**
 * Generates a cryptographically secure unbiased random integer in range.
 * @param min - Minimum value (inclusive).
 * @param max - Maximum value (inclusive).
 * @returns Random integer.
 */
export function integer(min: number, max: number): number {
  const range = max - min;
  if (range === 0) return min;
  return min + crypto.randomInt(range + 1);
}

/**
 * Selects a random element from an array.
 * @param array - Array to choose from.
 * @returns Random element.
 */
export function choice<T>(array: T[]): T {
  return array[crypto.randomInt(array.length)];
}

/**
 * Fisher-Yates shuffle using secure random.
 * @param array - Array to shuffle.
 * @returns Shuffled array.
 */
export function shuffle<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}