/**
 * Cryptographically secure random utilities.
 * All entropy sourced from crypto.getRandomValues - no Math.random.
 */

const DEFAULT_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HEX_CHARSET = "0123456789abcdef";

/**
 * Returns a cryptographically secure random 32-bit unsigned integer.
 * Internal helper used by the public functions below.
 */
function randomUint32(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0];
}

/**
 * Random integer in [min, max] (inclusive on both ends).
 * Throws if min > max.
 */
export function randomInt(min: number, max: number): number {
  if (min > max) throw new RangeError(`min (${min}) must be <= max (${max})`);
  if (min === max) return min;
  const range = max - min + 1;
  // Rejection sampling to avoid modulo bias.
  const limit = 2 ** 32 - (2 ** 32 % range);
  let value: number;
  do {
    value = randomUint32();
  } while (value >= limit);
  return min + (value % range);
}

/**
 * Random float in [min, max).
 * Throws if min >= max.
 */
export function randomFloat(min: number, max: number): number {
  if (min >= max) throw new RangeError(`min (${min}) must be < max (${max})`);
  // 53 bits of randomness - same resolution as Math.random but cryptographic.
  const hi = randomUint32() >>> 5;
  const lo = randomUint32() >>> 6;
  const fraction = (hi * 67108864 + lo) / 9007199254740992; // 2^53
  return min + fraction * (max - min);
}

/**
 * Returns a single random element from the array.
 * Returns undefined for empty arrays.
 */
export function randomChoice<T>(arr: readonly T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[randomInt(0, arr.length - 1)];
}

/**
 * Returns n unique elements drawn at random from arr (without replacement).
 * Throws if n > arr.length.
 */
export function randomSample<T>(arr: readonly T[], n: number): T[] {
  if (n > arr.length) {
    throw new RangeError(
      `n (${n}) exceeds array length (${arr.length})`
    );
  }
  if (n === 0) return [];
  // Fisher-Yates partial shuffle on a copy.
  const copy = [...arr];
  for (let i = 0; i < n; i++) {
    const j = randomInt(i, copy.length - 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/**
 * Returns a new array with the same elements in a cryptographically random order.
 * Does not mutate the input.
 */
export function shuffle<T>(arr: readonly T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Generates a random string of the given length.
 * Optional charset defaults to A-Z a-z 0-9 (62 chars).
 * Charset must be non-empty and at most 256 characters.
 */
export function randomString(len: number, charset = DEFAULT_CHARSET): string {
  if (len < 0) throw new RangeError("len must be >= 0");
  if (charset.length === 0) throw new RangeError("charset must be non-empty");
  if (charset.length > 256) throw new RangeError("charset max length is 256");

  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);

  // Rejection sampling per byte to avoid modulo bias.
  const limit = 256 - (256 % charset.length);
  const chars: string[] = [];
  let i = 0;
  while (chars.length < len) {
    if (i >= bytes.length) {
      crypto.getRandomValues(bytes);
      i = 0;
    }
    if (bytes[i] < limit) {
      chars.push(charset[bytes[i] % charset.length]);
    }
    i++;
  }
  return chars.join("");
}

/**
 * Generates a random lowercase hexadecimal string of the given length.
 */
export function randomHex(len: number): string {
  return randomString(len, HEX_CHARSET);
}

/**
 * Returns true or false with equal probability.
 */
export function coinFlip(): boolean {
  return (randomUint32() & 1) === 1;
}
