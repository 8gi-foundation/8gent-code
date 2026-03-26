/**
 * Builds frequency histogram from numeric data.
 * @param data - Array of numbers.
 * @param bins - Number of bins.
 * @returns Array of bin objects with min, max, and count.
 */
function histogram(data: number[], bins: number): { min: number; max: number; count: number }[] {
  if (data.length === 0) return [];
  const min = Math.min(...data);
  const max = Math.max(...data);
  const width = (max - min) / bins;
  const result: { min: number; max: number; count: number }[] = [];
  for (let i = 0; i < bins; i++) {
    const currentMin = min + i * width;
    const currentMax = currentMin + width;
    let count = 0;
    for (const d of data) {
      if (d >= currentMin && d < currentMax) count++;
    }
    result.push({ min: currentMin, max: currentMax, count });
  }
  return result;
}

/**
 * Auto-selects bin count using Sturges' rule.
 * @param data - Array of numbers.
 * @param maxBins - Maximum allowed bins.
 * @returns Optimal bin count.
 */
function auto(data: number[], maxBins: number = 100): number {
  if (data.length === 0) return 1;
  const n = data.length;
  const sturges = Math.floor(Math.log2(n)) + 1;
  return Math.min(sturges, maxBins);
}

/**
 * Converts bin counts to frequencies.
 * @param bins - Array of bin objects.
 * @returns Array of bin objects with normalized counts.
 */
function normalize(bins: { min: number; max: number; count: number }[]): { min: number; max: number; count: number }[] {
  const total = bins.reduce((sum, b) => sum + b.count, 0);
  return bins.map(b => ({ ...b, count: total === 0 ? 0 : b.count / total }));
}

/**
 * Builds cumulative distribution function (CDF).
 * @param bins - Array of bin objects.
 * @returns Array of bin objects with cumulative counts.
 */
function cumulative(bins: { min: number; max: number; count: number }[]): { min: number; max: number; count: number }[] {
  let sum = 0;
  return bins.map(b => {
    sum += b.count;
    return { ...b, count: sum };
  });
}

export { histogram, auto, normalize, cumulative };