/**
 * Check if a number is prime using Miller-Rabin test.
 * @param n - Number to check.
 * @returns True if n is prime, false otherwise.
 */
export function isPrime(n: number): boolean {
  if (n < 2) return false;
  let d = n - 1;
  let s = 0;
  while (d % 2 === 0) {
    d /= 2;
    s++;
  }
  const bases = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37];
  for (const a of bases) {
    if (a >= n) continue;
    let x = modPow(a, d, n);
    if (x === 1 || x === n - 1) continue;
    let repeat = s - 1;
    while (repeat-- > 0) {
      x = modPow(x, 2, n);
      if (x === n - 1) break;
    }
    if (x !== n - 1) return false;
  }
  return true;
}

/**
 * Compute greatest common divisor.
 * @param a - First number.
 * @param b - Second number.
 * @returns GCD of a and b.
 */
function gcd(a: number, b: number): number {
  while (b) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

/**
 * Compute modular exponentiation.
 * @param base - Base.
 * @param exp - Exponent.
 * @param mod - Modulus.
 * @returns (base^exp) mod mod.
 */
function modPow(base: number, exp: number, mod: number): number {
  if (mod === 1) return 0;
  let result = 1;
  base = base % mod;
  while (exp > 0) {
    if (exp % 2 === 1) result = (result * base) % mod;
    exp = Math.floor(exp / 2);
    base = (base * base) % mod;
  }
  return result;
}

/**
 * Find a non-trivial factor of n using Pollard's rho algorithm.
 * @param n - Number to factor.
 * @returns A non-trivial factor of n.
 */
export function pollardsRho(n: number): number {
  if (n % 2 === 0) return 2;
  if (n % 3 === 0) return 3;
  if (n % 5 === 0) return 5;
  const f = (x: number, c: number) => (x * x + c) % n;
  let x = 1, y = 1, d = 1, c = 1;
  while (d === 1) {
    x = f(x, c);
    y = f(f(y, c), c);
    d = gcd(Math.abs(x - y), n);
  }
  return d !== n ? d : pollardsRho(n);
}

/**
 * Factorize an integer into prime factors with exponents.
 * @param n - Number to factorize.
 * @returns Array of { prime, exponent } objects sorted by prime.
 */
export function factor(n: number): { prime: number; exponent: number }[] {
  if (n === 1) return [];
  const result: { prime: number; exponent: number }[] = [];
  let remaining = n;
  for (let i = 2; i * i <= remaining && i < 1000; i++) {
    while (remaining % i === 0) {
      const idx = result.findIndex(f => f.prime === i);
      if (idx !== -1) result[idx].exponent++;
      else result.push({ prime: i, exponent: 1 });
      remaining /= i;
    }
  }
  if (remaining === 1) return result.sort((a, b) => a.prime - b.prime);
  if (isPrime(remaining)) {
    result.push({ prime: remaining, exponent: 1 });
    return result.sort((a, b) => a.prime - b.prime);
  }
  const d = pollardsRho(remaining);
  return [...factor(d), ...factor(remaining / d)].sort((a, b) => a.prime - b.prime);
}