/**
 * Calculate the sum of an array.
 * @param arr - The input array.
 * @returns The sum of the array elements.
 */
function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

/**
 * Calculate the mean of an array.
 * @param arr - The input array.
 * @returns The mean of the array elements.
 */
function mean(arr: number[]): number {
  return sum(arr) / arr.length;
}

/**
 * Find the minimum value in an array.
 * @param arr - The input array.
 * @returns The minimum value.
 */
function min(arr: number[]): number {
  return Math.min(...arr);
}

/**
 * Find the maximum value in an array.
 * @param arr - The input array.
 * @returns The maximum value.
 */
function max(arr: number[]): number {
  return Math.max(...arr);
}

/**
 * Calculate the range of an array.
 * @param arr - The input array.
 * @returns The difference between max and min.
 */
function range(arr: number[]): number {
  return max(arr) - min(arr);
}

/**
 * Calculate the median of an array.
 * @param arr - The input array.
 * @returns The median value.
 */
function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  } else {
    return sorted[mid];
  }
}

/**
 * Find the mode of an array.
 * @param arr - The input array.
 * @returns The most frequent value or undefined.
 */
function mode(arr: number[]): number | undefined {
  const counts = new Map<number, number>();
  let maxCount = 0;
  let modeValue: number | undefined;

  for (const num of arr) {
    counts.set(num, (counts.get(num) || 0) + 1);
    if (counts.get(num)! > maxCount) {
      maxCount = counts.get(num)!;
      modeValue = num;
    }
  }

  return maxCount > 0 ? modeValue : undefined;
}

/**
 * Calculate the variance of an array.
 * @param arr - The input array.
 * @returns The sample variance.
 */
function variance(arr: number[]): number {
  const m = mean(arr);
  return sum(arr.map(x => Math.pow(x - m, 2))) / (arr.length - 1);
}

/**
 * Calculate the standard deviation of an array.
 * @param arr - The input array.
 * @returns The standard deviation.
 */
function stddev(arr: number[]): number {
  return Math.sqrt(variance(arr));
}

/**
 * Calculate the percentile of an array.
 * @param arr - The input array.
 * @param p - The percentile (0-100).
 * @returns The value at the specified percentile.
 */
function percentile(arr: number[], p: number): number {
  if (p < 0 || p > 100) {
    throw new Error('Percentile must be between 0 and 100');
  }
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  const index = (n - 1) * (p / 100);
  const floor = Math.floor(index);
  const ceil = Math.ceil(index);
  if (floor === ceil) {
    return sorted[floor];
  }
  const frac = index - floor;
  return sorted[floor] * (1 - frac) + sorted[ceil] * frac;
}

/**
 * Generate a histogram of an array.
 * @param arr - The input array.
 * @param bins - The number of bins.
 * @returns An array of { value, count } objects.
 */
function histogram(arr: number[], bins: number): { value: number; count: number }[] {
  if (arr.length === 0) return [];
  const minVal = min(arr);
  const maxVal = max(arr);
  const binWidth = (maxVal - minVal) / bins;
  const result: { value: number; count: number }[] = [];
  let currentMin = minVal;
  for (let i = 0; i < bins; i++) {
    const currentMax = currentMin + binWidth;
    const count = arr.filter(x => x >= currentMin && x < currentMax).length;
    result.push({ value: currentMin + binWidth / 2, count });
    currentMin = currentMax;
  }
  return result;
}

export {
  sum,
  mean,
  min,
  max,
  range,
  median,
  mode,
  variance,
  stddev,
  percentile,
  histogram
};