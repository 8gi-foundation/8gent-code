/**
 * benchmark-harness.ts
 * Micro-benchmark harness: warmup, N iterations, p50/p95/p99 latency stats,
 * and side-by-side implementation comparison.
 */

export interface BenchOptions {
  iterations?: number;
  warmup?: number;
  unit?: "ms" | "us" | "ns";
}

export interface BenchResult {
  name: string;
  iterations: number;
  unit: string;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  totalMs: number;
}

export interface CompareResult {
  results: BenchResult[];
  fastest: string;
  slowest: string;
  ratio: number; // slowest / fastest mean
  table: string;
}

function now(): number {
  return performance.now();
}

function toUnit(ms: number, unit: "ms" | "us" | "ns"): number {
  if (unit === "ms") return ms;
  if (unit === "us") return ms * 1000;
  return ms * 1_000_000;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function formatNum(n: number): string {
  return n < 10 ? n.toFixed(3) : n < 100 ? n.toFixed(2) : n.toFixed(1);
}

/**
 * Run a single benchmark.
 */
export async function bench(
  name: string,
  fn: () => unknown | Promise<unknown>,
  options: BenchOptions = {}
): Promise<BenchResult> {
  const { iterations = 1000, warmup = 50, unit = "ms" } = options;

  // Warmup - not recorded
  for (let i = 0; i < warmup; i++) {
    await fn();
  }

  const samples: number[] = [];
  const start = now();

  for (let i = 0; i < iterations; i++) {
    const t0 = now();
    await fn();
    samples.push(now() - t0);
  }

  const totalMs = now() - start;
  samples.sort((a, b) => a - b);

  const convert = (v: number) => toUnit(v, unit);
  const converted = samples.map(convert);

  const mean = converted.reduce((a, b) => a + b, 0) / converted.length;

  const result: BenchResult = {
    name,
    iterations,
    unit,
    min: convert(samples[0]),
    max: convert(samples[samples.length - 1]),
    mean,
    p50: percentile(converted, 50),
    p95: percentile(converted, 95),
    p99: percentile(converted, 99),
    totalMs,
  };

  const label = `[bench] ${name}`;
  const stats =
    `mean=${formatNum(result.mean)}${unit}  ` +
    `p50=${formatNum(result.p50)}${unit}  ` +
    `p95=${formatNum(result.p95)}${unit}  ` +
    `p99=${formatNum(result.p99)}${unit}  ` +
    `(${iterations} iters, ${totalMs.toFixed(1)}ms total)`;
  console.log(`${label}  ${stats}`);

  return result;
}

/**
 * Run multiple implementations and print a comparison table.
 */
export async function compare(
  implementations: Record<string, () => unknown | Promise<unknown>>,
  options: BenchOptions = {}
): Promise<CompareResult> {
  const results: BenchResult[] = [];

  for (const [name, fn] of Object.entries(implementations)) {
    results.push(await bench(name, fn, options));
  }

  const byMean = [...results].sort((a, b) => a.mean - b.mean);
  const fastest = byMean[0];
  const slowest = byMean[byMean.length - 1];
  const ratio = fastest.mean > 0 ? slowest.mean / fastest.mean : 1;

  const unit = results[0]?.unit ?? "ms";
  const colW = 18;
  const pad = (s: string, w = colW) => s.padEnd(w);

  const header =
    pad("name") +
    pad("mean") +
    pad("p50") +
    pad("p95") +
    pad("p99") +
    pad("min") +
    pad("max");

  const divider = "-".repeat(header.length);

  const rows = results.map((r) =>
    pad(r.name) +
    pad(`${formatNum(r.mean)}${unit}`) +
    pad(`${formatNum(r.p50)}${unit}`) +
    pad(`${formatNum(r.p95)}${unit}`) +
    pad(`${formatNum(r.p99)}${unit}`) +
    pad(`${formatNum(r.min)}${unit}`) +
    pad(`${formatNum(r.max)}${unit}`)
  );

  const table = [divider, header, divider, ...rows, divider].join("\n");

  console.log("\n" + table);
  console.log(
    `\nFastest: ${fastest.name}  Slowest: ${slowest.name}  Ratio: ${ratio.toFixed(2)}x\n`
  );

  return { results, fastest: fastest.name, slowest: slowest.name, ratio, table };
}
