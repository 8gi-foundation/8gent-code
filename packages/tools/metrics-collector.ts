const counters = new Map<string, number>();
const gauges = new Map<string, number>();
const histograms = new Map<string, number[]>();

/**
 * Increments the counter for the given name.
 * @param name - The name of the counter.
 */
export function counter(name: string): void {
  counters.set(name, (counters.get(name) || 0) + 1);
}

/**
 * Sets the gauge value for the given name.
 * @param name - The name of the gauge.
 * @param value - The value to set.
 */
export function gauge(name: string, value: number): void {
  gauges.set(name, value);
}

/**
 * Records an observation for the histogram with the given name.
 * @param name - The name of the histogram.
 * @param value - The value to record.
 */
export function histogram(name: string, value: number): void {
  let values = histograms.get(name) || [];
  values.push(value);
  histograms.set(name, values);
}

/**
 * Returns a snapshot of all metrics.
 * @returns An object containing counters, gauges, and histograms.
 */
export function getAll(): {
  counters: { [key: string]: number };
  gauges: { [key: string]: number };
  histograms: { [key: string]: number[] };
} {
  return {
    counters: Object.fromEntries(counters),
    gauges: Object.fromEntries(gauges),
    histograms: Object.fromEntries(
      Array.from(histograms.entries()).map(([k, v]) => [k, [...v]])
    ),
  };
}

/**
 * Resets all metrics to their initial state.
 */
export function reset(): void {
  counters.clear();
  gauges.clear();
  histograms.clear();
}