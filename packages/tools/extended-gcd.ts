/**
 * Compute the extended GCD of two BigInts.
 * @param a - First number.
 * @param b - Second number.
 * @returns Object with gcd, x, y such that ax + by = gcd.
 */
function extendedGcd(a: bigint, b: bigint): { gcd: bigint; x: bigint; y: bigint } {
    const aAbs = a < 0n ? -a : a;
    const bAbs = b < 0n ? -b : b;
    if (bAbs === 0n) {
        return { gcd: aAbs, x: 1n, y: 0n };
    }
    const { gcd, x: x1, y: y1 } = extendedGcd(bAbs, aAbs % bAbs);
    const x = y1;
    const y = x1 - (aAbs / bAbs) * y1;
    return { gcd, x, y };
}

/**
 * Compute the least common multiple of two BigInts.
 * @param a - First number.
 * @param b - Second number.
 * @returns LCM of a and b.
 */
function lcm(a: bigint, b: bigint): bigint {
    if (a === 0n || b === 0n) {
        return 0n;
    }
    const { gcd } = extendedGcd(a, b);
    return (a * b) / gcd;
}

/**
 * Compute the modular inverse of a modulo m.
 * @param a - Number to invert.
 * @param m - Modulus.
 * @returns Modular inverse if it exists, else null.
 */
function modInverse(a: bigint, m: bigint): bigint | null {
    const { gcd, x } = extendedGcd(a, m);
    if (gcd !== 1n) {
        return null;
    }
    return x % m;
}

export { extendedGcd, lcm, modInverse };