/**
 * Calculates the sum of proper divisors of n.
 * @param n - The number to calculate for.
 * @returns Sum of proper divisors.
 */
function sumProperDivisors(n: number): number {
  if (n === 1) return 0;
  let sum = 1;
  const sqrtN = Math.sqrt(n);
  for (let i = 2; i <= sqrtN; i++) {
    if (n % i === 0) {
      sum += i;
      const other = n / i;
      if (other !== i) {
        sum += other;
      }
    }
  }
  return sum;
}

/**
 * Returns proper divisors of n.
 * @param n - The number to find divisors for.
 * @returns Array of proper divisors.
 */
function getProperDivisors(n: number): number[] {
  if (n === 1) return [];
  const divisors: number[] = [1];
  const sqrtN = Math.sqrt(n);
  for (let i = 2; i <= sqrtN; i++) {
    if (n % i === 0) {
      divisors.push(i);
      const other = n / i;
      if (other !== i) {
        divisors.push(other);
      }
    }
  }
  return divisors.sort((a, b) => a - b);
}

/**
 * Checks if a number is perfect.
 * @param n - The number to check.
 * @returns True if perfect.
 */
function isPerfect(n: number): boolean {
  return sumProperDivisors(n) === n;
}

/**
 * Checks if a number is abundant.
 * @param n - The number to check.
 * @returns True if abundant.
 */
function isAbundant(n: number): boolean {
  return sumProperDivisors(n) > n;
}

/**
 * Checks if a number is deficient.
 * @param n - The number to check.
 * @returns True if deficient.
 */
function isDeficient(n: number): boolean {
  return sumProperDivisors(n) < n;
}

/**
 * Checks if a number is semiperfect.
 * @param n - The number to check.
 * @returns True if semiperfect.
 */
function isSemiperfect(n: number): boolean {
  const divisors = getProperDivisors(n);
  return subsetSum(divisors, n);
}

/**
 * Helper for subset sum.
 * @param arr - Array of numbers.
 * @param target - Target sum.
 * @returns True if subset sums to target.
 */
function subsetSum(arr: number[], target: number): boolean {
  if (target === 0) return true;
  if (arr.length === 0) return false;
  const [first, ...rest] = arr;
  return subsetSum(rest, target) || subsetSum(rest, target - first);
}

/**
 * Checks if two numbers are amicable.
 * @param a - First number.
 * @param b - Second number.
 * @returns True if amicable.
 */
function isAmicable(a: number, b: number): boolean {
  return a !== b && sumProperDivisors(a) === b && sumProperDivisors(b) === a;
}

/**
 * Returns prime factors of n.
 * @param n - The number to factor.
 * @returns Array of [prime, exponent] pairs.
 */
function primeFactors(n: number): [number, number][] {
  const factors: [number, number][] = [];
  let current = n;
  for (let i = 2; i * i <= current; i++) {
    if (current % i === 0) {
      let exp = 0;
      while (current % i === 0) {
        current /= i;
        exp++;
      }
      factors.push([i, exp]);
    }
  }
  if (current > 1) {
    factors.push([current, 1]);
  }
  return factors;
}

/**
 * Liouville function λ(n).
 * @param n - The number to calculate for.
 * @returns Liouville value.
 */
function liouville(n: number): number {
  if (n === 0) return 0;
  if (n === 1) return 1;
  const factors = primeFactors(n);
  let count = 0;
  for (const [p, exp] of factors) {
    count += exp;
  }
  return Math.pow(-1, count);
}

/**
 * Mobius function μ(n).
 * @param n - The number to calculate for.
 * @returns Mobius value.
 */
function mobius(n: number): number {
  if (n === 0) return 0;
  if (n === 1) return 1;
  const factors = primeFactors(n);
  for (const [p, exp] of factors) {
    if (exp > 1) return 0;
  }
  return Math.pow(-1, factors.length);
}

/**
 * Von Mangoldt function Λ(n).
 * @param n - The number to calculate for.
 * @returns Von Mangoldt value.
 */
function vonMangoldt(n: number): number {
  if (n === 1) return 0;
  const factors = primeFactors(n);
  if (factors.length === 1 && factors[0][1] >= 1) {
    return Math.log(factors[0][0]);
  }
  return 0;
}

export {
  sumProperDivisors,
  getProperDivisors,
  isPerfect,
  isAbundant,
  isDeficient,
  isSemiperfect,
  isAmicable,
  primeFactors,
  liouville,
  mobius,
  vonMangoldt,
  subsetSum,
};