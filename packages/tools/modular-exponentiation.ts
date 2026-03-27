/**
 * Computes base^exp mod mod using fast exponentiation.
 * @param base - The base.
 * @param exp - The exponent.
 * @param mod - The modulus.
 * @returns The result of (base^exp) mod mod.
 */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
    let result = 1n;
    base = base % mod;
    while (exp > 0n) {
        if (exp % 2n === 1n) {
            result = (result * base) % mod;
        }
        base = (base * base) % mod;
        exp = exp / 2n;
    }
    return result;
}

/**
 * Computes the modular inverse using Fermat's little theorem.
 * Assumes mod is prime.
 * @param a - The number to invert.
 * @param mod - The prime modulus.
 * @returns The modular inverse of a mod mod, or 0 if no inverse exists.
 */
function modInv(a: bigint, mod: bigint): bigint {
    return modPow(a, mod - 2n, mod);
}

/**
 * Extended Euclidean algorithm.
 * @param a - First number.
 * @param b - Second number.
 * @returns A tuple [gcd, x, y] such that ax + by = gcd.
 */
function extendedGcd(a: bigint, b: bigint): [bigint, bigint, bigint] {
    if (b === 0n) return [a, 1n, 0n];
    const [g, x, y] = extendedGcd(b, a % b);
    return [g, y, x - (a / b) * y];
}

/**
 * Solves a system of congruences using the Chinese Remainder Theorem.
 * @param congruences - Array of {a, m} pairs representing x ≡ a mod m.
 * @returns The solution x, or null if no solution exists.
 */
function crt(congruences: Array<{a: bigint, m: bigint}>): bigint | null {
    let x = 0n;
    let m = 1n;
    for (const {a, m: mi} of congruences) {
        const [g, x1, x2] = extendedGcd(m, mi);
        if ((a - x) % g !== 0n) return null;
        const lcm = m * mi / g;
        const tmp = ((x - a) / g * x1) % (mi / g);
        x = x + tmp * m;
        m = lcm;
    }
    return x;
}

export { modPow, modInv, crt };