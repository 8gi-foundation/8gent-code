/**
 * Performs integer floor division of two BigInts.
 * @param n - The dividend.
 * @param d - The divisor.
 * @returns The result of floor division.
 */
export function bigFloor(n: bigint, d: bigint): bigint {
  return BigInt((n - (n % d)) / d);
}

/**
 * Performs integer ceiling division of two BigInts.
 * @param n - The dividend.
 * @param d - The divisor.
 * @returns The result of ceiling division.
 */
export function bigCeil(n: bigint, d: bigint): bigint {
  return BigInt((n + d - 1n) / d);
}

/**
 * Computes the greatest common divisor of two BigInts.
 * @param a - First number.
 * @param b - Second number.
 * @returns The GCD.
 */
export function bigGCD(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const temp = b;
    b = a % b;
    a = temp;
  }
  return a;
}

/**
 * Computes the least common multiple of two BigInts.
 * @param a - First number.
 * @param b - Second number.
 * @returns The LCM.
 */
export function bigLCM(a: bigint, b: bigint): bigint {
  return BigInt((a * b) / bigGCD(a, b));
}

/**
 * Computes the integer exponentiation of a BigInt.
 * @param base - The base.
 * @param exp - The exponent.
 * @returns The result of base^exp.
 */
export function bigPow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  for (let i = 0n; i < exp; i++) {
    result *= base;
  }
  return result;
}