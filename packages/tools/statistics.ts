/**
 * Calculate the arithmetic mean of an array.
 * @param arr - Numeric array
 * @returns Mean value or NaN if empty
 */
function mean(arr: number[]): number {
  if (arr.length === 0) return NaN;
  const sum = arr.reduce((a, b) => a + b, 0);
  return sum / arr.length;
}

/**
 * Calculate the median of an array.
 * @param arr - Numeric array
 * @returns Median value or NaN if empty
 */
function median(arr: number[]): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Find the mode(s) of an array.
 * @param arr - Numeric array
 * @returns Array of modes or empty array if none
 */
function mode(arr: number[]): number[] {
  if (arr.length === 0) return [];
  const freq = new Map<number, number>();
  for (const num of arr) {
    freq.set(num, (freq.get(num) || 0) + 1);
  }
  let maxFreq = 0;
  for (const count of freq.values()) {
    if (count > maxFreq) maxFreq = count;
  }
  const modes = [];
  for (const [num, count] of freq.entries()) {
    if (count === maxFreq) modes.push(num);
  }
  return modes;
}

/**
 * Calculate variance (population or sample).
 * @param arr - Numeric array
 * @param sample - Whether to use sample variance (n-1)
 * @returns Variance value or NaN if empty
 */
function variance(arr: number[], sample: boolean = false): number {
  if (arr.length === 0) return NaN;
  const meanVal = mean(arr);
  const sumSq = arr.reduce((sum, x) => sum + (x - meanVal) ** 2, 0);
  const n = arr.length;
  const denominator = sample ? n - 1 : n;
  return denominator === 0 ? NaN : sumSq / denominator;
}

/**
 * Calculate standard deviation (population or sample).
 * @param arr - Numeric array
 * @param sample - Whether to use sample standard deviation (n-1)
 * @returns Standard deviation or NaN if empty
 */
function stdDev(arr: number[], sample: boolean = false): number {
  return Math.sqrt(variance(arr, sample));
}

export { mean, median, mode, variance, stdDev };