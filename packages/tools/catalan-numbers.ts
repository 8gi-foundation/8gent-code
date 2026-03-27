/**
 * Calculate the nth Catalan number using the formula C(2n,n)/(n+1)
 * @param n - The index (0-based)
 * @returns The nth Catalan number as a BigInt
 */
export function catalan(n: number): bigint {
  const a = 2n * BigInt(n);
  const b = BigInt(n);
  const comb = combination(a, b);
  return comb / (BigInt(n) + 1n);
}

/**
 * Generate all balanced parenthesis strings for n pairs
 * @param n - Number of pairs
 * @yields Each valid string
 */
export function* generateParenthesis(n: number): Generator<string> {
  if (n === 0) yield '';
  for (let i = 0; i < n; i++) {
    for (const left of generateParenthesis(i)) {
      for (const right of generateParenthesis(n - 1 - i)) {
        yield '(' + left + ')' + right;
      }
    }
  }
}

/**
 * Asymptotic approximation of Catalan numbers for large n
 * @param n - The index
 * @returns Approximation as a number
 */
export function asymptotic(n: number): number {
  return Math.pow(4, n) / (Math.pow(n, 1.5) * Math.sqrt(Math.PI));
}

function combination(a: bigint, b: bigint): bigint {
  if (b > a || b < 0n) return 0n;
  if (b === 0n || b === a) return 1n;
  const min = Math.min(Number(b), Number(a - b));
  let numerator = 1n;
  let denominator = 1n;
  for (let i = 1; i <= min; i++) {
    numerator *= a - BigInt(min) + BigInt(i);
    denominator *= BigInt(i);
  }
  return numerator / denominator;
}