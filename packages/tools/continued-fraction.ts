/**
 * Converts a real number to its continued fraction coefficients.
 * @param x - The real number to convert.
 * @returns An array of continued fraction coefficients.
 */
export function continuedFraction(x: number): number[] {
  const a: number[] = [];
  let epsilon = 1e-10;
  while (a.length < 100) {
    const a0 = Math.floor(x);
    a.push(a0);
    x = 1 / (x - a0);
    if (Math.abs(x - Math.floor(x)) < epsilon) break;
  }
  return a;
}

/**
 * Computes the sequence of convergents from continued fraction coefficients.
 * @param coefficients - The continued fraction coefficients.
 * @returns An array of convergents as {numerator, denominator} objects.
 */
export function convergents(coefficients: number[]): Array<{numerator: number, denominator: number}> {
  const result: Array<{numerator: number, denominator: number}> = [];
  if (coefficients.length === 0) return result;
  result.push({ numerator: coefficients[0], denominator: 1 });
  let h = [1, coefficients[0]];
  let k = [0, 1];
  for (let i = 1; i < coefficients.length; i++) {
    const a = coefficients[i];
    const newH = a * h[i] + h[i - 1];
    const newK = a * k[i] + k[i - 1];
    h.push(newH);
    k.push(newK);
    result.push({ numerator: newH, denominator: newK });
  }
  return result;
}

/**
 * Checks if the continued fraction coefficients represent a periodic continued fraction (quadratic irrational).
 * @param coefficients - The continued fraction coefficients.
 * @returns True if the coefficients are periodic, false otherwise.
 */
export function isPeriodic(coefficients: number[]): boolean {
  if (coefficients.length < 2) return false;
  const tail = coefficients.slice(1);
  const first = tail[0];
  for (let i = 1; i < tail.length; i++) {
    if (tail[i] !== first) return false;
  }
  return true;
}