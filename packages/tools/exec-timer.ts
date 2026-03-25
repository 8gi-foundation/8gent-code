/**
 * exec-timer - measures execution time of sync and async functions.
 *
 * API:
 *   time(fn)                     -> { result, durationMs }
 *   timeAsync(fn)                -> Promise<{ result, durationMs }>
 *   benchmark(fn, iterations)    -> BenchmarkStats
 *   benchmarkAsync(fn, iters)    -> Promise<BenchmarkStats>
 */

export interface TimedResult<T> {
  result: T;
  durationMs: number;
}

export interface BenchmarkStats {
  mean: number;
  median: number;
  min: number;
  max: number;
  p95: number;
  iterations: number;
}

/**
 * Measures execution time of a synchronous function.
 * Returns the function result alongside elapsed milliseconds.
 */
export function time<T>(fn: () => T): TimedResult<T> {
  const start = performance.now();
  const result = fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}

/**
 * Measures execution time of an async function.
 * Awaits the promise and returns the resolved value alongside elapsed milliseconds.
 */
export async function timeAsync<T>(fn: () => Promise<T>): Promise<TimedResult<T>> {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}

/**
 * Runs a sync function N times and returns aggregate timing statistics.
 * Useful for micro-benchmarking hot paths.
 */
export function benchmark(fn: () => unknown, iterations = 100): BenchmarkStats {
  if (iterations < 1) {
    throw new RangeError(`iterations must be >= 1, got ${iterations}`);
  }

  const samples: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }

  return computeStats(samples);
}

/**
 * Async variant of benchmark. Runs an async function N times sequentially
 * and returns aggregate timing statistics.
 */
export async function benchmarkAsync(
  fn: () => Promise<unknown>,
  iterations = 100
): Promise<BenchmarkStats> {
  if (iterations < 1) {
    throw new RangeError(`iterations must be >= 1, got ${iterations}`);
  }

  const samples: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }

  return computeStats(samples);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function computeStats(samples: number[]): BenchmarkStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;

  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / n;

  const mid = Math.floor(n / 2);
  const median = n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  const p95Index = Math.ceil(n * 0.95) - 1;

  return {
    mean: round(mean),
    median: round(median),
    min: round(sorted[0]),
    max: round(sorted[n - 1]),
    p95: round(sorted[Math.min(p95Index, n - 1)]),
    iterations: n,
  };
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}
