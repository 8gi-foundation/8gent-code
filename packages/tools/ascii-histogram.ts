/**
 * Builds a histogram with auto-calculated bins using Sturges' rule.
 * @param values Array of numeric values.
 * @param bins Optional number of bins. Defaults to Sturges' rule.
 * @returns Histogram object with bin ranges and counts.
 */
export function build(values: number[], bins?: number): { bins: number[][], counts: number[] } {
  const n = values.length;
  if (n === 0) return { bins: [], counts: [] };
  if (!bins) {
    bins = Math.log2(n) + 1;
    bins = Math.max(1, Math.floor(bins));
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const width = (max - min) / bins;
  const binEdges = [];
  let current = min;
  for (let i = 0; i <= bins; i++) {
    binEdges.push(current);
    current += width;
  }
  const binsArr: number[][] = [];
  for (let i = 0; i < bins; i++) {
    binsArr.push([binEdges[i], binEdges[i + 1]]);
  }
  const counts = new Array(bins).fill(0);
  for (const value of values) {
    let idx = 0;
    for (let i = 0; i < bins; i++) {
      if (value >= binEdges[i] && value < binEdges[i + 1]) {
        idx = i;
        break;
      }
    }
    counts[idx]++;
  }
  return { bins: binsArr, counts };
}

/**
 * Renders an ASCII bar chart from a histogram.
 * @param histogram Histogram object with bin ranges and counts.
 * @returns ASCII bar chart string.
 */
export function render(histogram: { bins: number[][], counts: number[] }): string {
  if (histogram.counts.length === 0) return '';
  const maxCount = Math.max(...histogram.counts);
  const scale = 50 / maxCount;
  let result = '';
  for (let i = 0; i < histogram.bins.length; i++) {
    const [start, end] = histogram.bins[i];
    const count = histogram.counts[i];
    const bar = '#'.repeat(Math.round(count * scale));
    result += `${start.toFixed(2)}-${end.toFixed(2)} | ${bar} ${count}\n`;
  }
  return result;
}

/**
 * Computes statistical summary of values.
 * @param values Array of numeric values.
 * @returns Object with min, max, mean, median, and standard deviation.
 */
export function stats(values: number[]): { min: number, max: number, mean: number, median: number, stddev: number } {
  if (values.length === 0) return { min: NaN, max: NaN, mean: NaN, median: NaN, stddev: NaN };
  const sorted = [...values].sort((a, b) => a - b);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const median = values.length % 2 === 1 
    ? sorted[Math.floor(values.length / 2)] 
    : (sorted[values.length / 2 - 1] + sorted[values.length / 2]) / 2;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  const stddev = Math.sqrt(variance);
  return { min, max, mean, median, stddev };
}

/**
 * Computes cumulative frequency for each bin.
 * @param histogram Histogram object with counts.
 * @returns Array of cumulative frequencies.
 */
export function cumulative(histogram: { bins: number[][], counts: number[] }): number[] {
  return histogram.counts.reduce((acc, count) => {
    acc.push(acc[acc.length - 1] + count);
    return acc;
  }, [0]).slice(1);
}

/**
 * Computes relative frequency for each bin.
 * @param histogram Histogram object with counts.
 * @returns Array of relative frequencies.
 */
export function normalize(histogram: { bins: number[][], counts: number[] }): number[] {
  const total = histogram.counts.reduce((sum, count) => sum + count, 0);
  return histogram.counts.map(count => count / total);
}