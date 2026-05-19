/**
 * Compute the value at the given percentile (0-100) from a sorted array.
 * @param sorted - Sorted array of numbers.
 * @param p - Percentile (0-100).
 * @returns The value at the specified percentile.
 */
export function percentile(sorted: number[], p: number): number {
  const N = sorted.length;
  if (N === 0) throw new Error('Empty array');
  const position = (N - 1) * (p / 100) + 1;
  const index = Math.floor(position - 1);
  const fraction = position - 1 - index;
  if (index + 1 >= N) {
    return sorted[index];
  }
  return sorted[index] + fraction * (sorted[index + 1] - sorted[index]);
}

/**
 * Compute the value at the given quantile (0-1) from a sorted array.
 * @param sorted - Sorted array of numbers.
 * @param q - Quantile (0-1).
 * @returns The value at the specified quantile.
 */
export function quantile(sorted: number[], q: number): number {
  return percentile(sorted, q * 100);
}

/**
 * Compute the interquartile range (IQR) of a sorted array.
 * @param sorted - Sorted array of numbers.
 * @returns The IQR (Q3 - Q1).
 */
export function iqr(sorted: number[]): number {
  const q1 = percentile(sorted, 25);
  const q3 = percentile(sorted, 75);
  return q3 - q1;
}

/**
 * Compute the first quartile (Q1), median, and third quartile (Q3) of a sorted array.
 * @param sorted - Sorted array of numbers.
 * @returns A tuple [Q1, median, Q3].
 */
export function quartiles(sorted: number[]): [number, number, number] {
  const q1 = percentile(sorted, 25);
  const median = percentile(sorted, 50);
  const q3 = percentile(sorted, 75);
  return [q1, median, q3];
}