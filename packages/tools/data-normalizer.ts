/**
 * Scales values to a specified range using min-max normalization.
 * @param values - Array of numbers to scale.
 * @param featureRange - Target range [min, max], defaults to [0, 1].
 * @returns Tuple of scaled values and transformation parameters for inversion.
 */
export function minMax(values: number[], featureRange: [number, number] = [0, 1]): [number[], { type: 'minMax'; min: number; max: number; range: [number, number] }] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = featureRange;
  const scaled = values.map(v => ((v - min) / (max - min + 1e-10)) * (range[1] - range[0]) + range[0]);
  return [scaled, { type: 'minMax', min, max, range }];
}

/**
 * Standardizes values to have zero mean and unit variance.
 * @param values - Array of numbers to standardize.
 * @returns Tuple of standardized values and transformation parameters for inversion.
 */
export function zScore(values: number[]): [number[], { type: 'zScore'; mean: number; std: number }] {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const std = Math.sqrt(values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length);
  const scaled = values.map(v => (v - mean) / (std + 1e-10));
  return [scaled, { type: 'zScore', mean, std }];
}

/**
 * Applies log transformation with zero-handling.
 * @param values - Array of numbers to transform.
 * @param base - Logarithm base, defaults to e.
 * @returns Tuple of transformed values and transformation parameters for inversion.
 */
export function log(values: number[], base: number = Math.E): [number[], { type: 'log'; base: number; epsilon: number }] {
  const epsilon = 1e-10;
  const scaled = values.map(v => Math.log(v + epsilon) / Math.log(base));
  return [scaled, { type: 'log', base, epsilon }];
}

/**
 * Scales values using median and IQR for robustness to outliers.
 * @param values - Array of numbers to scale.
 * @returns Tuple of scaled values and transformation parameters for inversion.
 */
export function robust(values: number[]): [number[], { type: 'robust'; median: number; iqr: number }] {
  const med = median(values);
  const iqrVal = iqr(values);
  const scaled = values.map(v => (v - med) / (iqrVal + 1e-10));
  return [scaled, { type: 'robust', median: med, iqr: iqrVal }];
}

/**
 * Inverts a transformation using stored parameters.
 * @param scaled - Transformed values.
 * @param params - Parameters from the original transformation.
 * @returns Original unscaled values.
 */
export function inverse(scaled: number[], params: { type: 'minMax' | 'zScore' | 'log' | 'robust'; [key: string]: any }): number[] {
  if (params.type === 'minMax') {
    const { min, max, range } = params;
    return scaled.map(v => (v - range[0]) * (max - min) / (range[1] - range[0]) + min);
  } else if (params.type === 'zScore') {
    const { mean, std } = params;
    return scaled.map(v => v * std + mean);
  } else if (params.type === 'log') {
    const { base, epsilon } = params;
    return scaled.map(v => Math.pow(base, v) - epsilon);
  } else if (params.type === 'robust') {
    const { median, iqr } = params;
    return scaled.map(v => v * iqr + median);
  } else {
    throw new Error('Unsupported transformation type');
  }
}

/**
 * Computes median of an array.
 * @param values - Array of numbers.
 * @returns Median value.
 */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Computes interquartile range (IQR) of an array.
 * @param values - Array of numbers.
 * @returns IQR value.
 */
function iqr(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = median(sorted.slice(0, Math.floor(sorted.length / 2)));
  const q3 = median(sorted.slice(Math.ceil(sorted.length / 2)));
  return q3 - q1;
}