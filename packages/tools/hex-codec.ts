/**
 * Efficient hex encoding and decoding for binary data.
 * @module hexUtils
 */

/**
 * Encodes binary data to lowercase hex string.
 * @param input - Uint8Array or string (treated as UTF-8)
 * @returns Lowercase hex string
 * @throws {Error} If input is invalid
 */
export function encode(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const hex = '0123456789abcdef';
  let result = '';
  for (const b of bytes) {
    result += hex[(b >> 4) & 15] + hex[b & 15];
  }
  return result;
}

/**
 * Decodes hex string to Uint8Array.
 * @param hex - Hex string (must be even-length, lowercase)
 * @returns Uint8Array
 * @throws {Error} If hex is invalid
 */
export function decode(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) {
    throw new Error('Invalid hex string: must be even-length and lowercase alphanumeric');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Converts number to lowercase hex string.
 * @param num - Number to convert
 * @param padTo - Optional padding length
 * @returns Lowercase hex string
 * @throws {Error} If num is negative
 */
export function toHex(num: number, padTo?: number): string {
  if (num < 0) throw new Error('Negative numbers not supported');
  let hex = num.toString(16);
  if (padTo) {
    hex = hex.padStart(padTo, '0');
  }
  return hex;
}

/**
 * Converts hex string to number.
 * @param hex - Hex string (must be valid)
 * @returns Number
 * @throws {Error} If hex is invalid
 */
export function fromHex(hex: string): number {
  if (!/^[0-9a-f]+$/.test(hex)) {
    throw new Error('Invalid hex string: must be alphanumeric');
  }
  return parseInt(hex, 16);
}