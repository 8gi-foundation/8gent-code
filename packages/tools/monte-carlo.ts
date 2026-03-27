/**
 * Runs Monte Carlo simulations.
 * @param scenarios - Parameters for the simulation.
 * @param iterations - Number of iterations to run.
 * @param sampleFn - Function to generate a single outcome.
 * @returns Array of simulation outcomes.
 */
export function simulate(scenarios: any, iterations: number, sampleFn: (scenarios: any) => number): number[] {
  const outcomes: number[] = [];
  for (let i = 0; i < iterations; i++) {
    outcomes.push(sampleFn(scenarios));
  }
  return outcomes;
}

/**
 * Estimates mean, standard deviation, and confidence interval.
 * @param outcomes - Array of simulation outcomes.
 * @returns Mean, standard deviation, and 95% confidence interval.
 */
export function estimate(outcomes: number[]): { mean: number; stddev: number; confidenceInterval: [number, number] } {
  const mean = outcomes.reduce((sum, x) => sum + x, 0) / outcomes.length;
  const stddev = Math.sqrt(
    outcomes.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) / (outcomes.length - 1)
  );
  const confidenceInterval = [mean - 1.96 * stddev / Math.sqrt(outcomes.length), mean + 1.96 * stddev / Math.sqrt(outcomes.length)];
  return { mean, stddev, confidenceInterval };
}

/**
 * Calculates the p-th percentile of outcomes.
 * @param outcomes - Array of simulation outcomes.
 * @param p - Percentile (0-100).
 * @returns The p-th percentile value.
 */
export function percentile(outcomes: number[], p: number): number {
  const sorted = [...outcomes].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const floor = Math.floor(index);
  const ceil = Math.ceil(index);
  return sorted[floor] + (sorted[ceil] - sorted[floor]) * (index - floor);
}

/**
 * Calculates the probability of loss below a threshold.
 * @param outcomes - Array of simulation outcomes.
 * @param threshold - Threshold value.
 * @returns Probability outcome is below threshold.
 */
export function riskOfLoss(outcomes: number[], threshold: number): number {
  return outcomes.filter(x => x < threshold).length / outcomes.length;
}

/**
 * Renders an ASCII histogram of outcomes.
 * @param outcomes - Array of simulation outcomes.
 * @returns ASCII histogram string.
 */
export function renderHistogram(outcomes: number[]): string {
  if (outcomes.length === 0) return '';
  const min = Math.min(...outcomes);
  const max = Math.max(...outcomes);
  const bins = 20;
  const binWidth = (max - min) / bins;
  const counts: number[] = new Array(bins).fill(0);
  for (const x of outcomes) {
    const bin = Math.floor((x - min) / binWidth);
    if (bin >= 0 && bin < bins) {
      counts[bin]++;
    }
  }
  let result = '';
  for (let i = 0; i < bins; i++) {
    const lower = min + i * binWidth;
    const upper = lower + binWidth;
    const bar = '*'.repeat(Math.floor(counts[i] / (outcomes.length / bins)));
    result += `${lower.toFixed(2)}-${upper.toFixed(2)} ${bar}\n`;
  }
  return result;
}