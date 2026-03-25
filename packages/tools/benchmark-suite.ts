/**
 * BenchmarkSuite - organizes benchmarks into named suites with
 * comparison, warmup, and formatted results.
 */

export interface BenchmarkResult {
  name: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  opsPerSec: number;
  isFastest?: boolean;
  isSlowest?: boolean;
}

export interface RunOptions {
  warmup?: number;
  iterations?: number;
  silent?: boolean;
}

type SyncFn = () => void;
type AsyncFn = () => Promise<void>;

interface BenchmarkEntry {
  name: string;
  fn: SyncFn | AsyncFn;
  isAsync: boolean;
}

const DEFAULT_WARMUP = 5;
const DEFAULT_ITERATIONS = 100;

export class BenchmarkSuite {
  private entries: BenchmarkEntry[] = [];
  private lastResults: BenchmarkResult[] = [];

  constructor(private suiteName: string = "Benchmark Suite") {}

  add(name: string, fn: SyncFn): this {
    this.entries.push({ name, fn, isAsync: false });
    return this;
  }

  addAsync(name: string, fn: AsyncFn): this {
    this.entries.push({ name, fn, isAsync: true });
    return this;
  }

  async run(options: RunOptions = {}): Promise<BenchmarkResult[]> {
    const warmup = options.warmup ?? DEFAULT_WARMUP;
    const iterations = options.iterations ?? DEFAULT_ITERATIONS;
    const silent = options.silent ?? false;

    if (!silent) {
      console.log("\n--- " + this.suiteName + " ---");
      console.log("warmup: " + warmup + " | iterations: " + iterations + "\n");
    }

    const results: BenchmarkResult[] = [];

    for (const entry of this.entries) {
      for (let i = 0; i < warmup; i++) {
        if (entry.isAsync) {
          await (entry.fn as AsyncFn)();
        } else {
          (entry.fn as SyncFn)();
        }
      }

      const times: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        if (entry.isAsync) {
          await (entry.fn as AsyncFn)();
        } else {
          (entry.fn as SyncFn)();
        }
        times.push(performance.now() - start);
      }

      const totalMs = times.reduce((a, b) => a + b, 0);
      const avgMs = totalMs / iterations;
      const minMs = Math.min(...times);
      const maxMs = Math.max(...times);
      const opsPerSec = 1000 / avgMs;

      results.push({ name: entry.name, iterations, totalMs, avgMs, minMs, maxMs, opsPerSec });
    }

    this.lastResults = this.compare(results);

    if (!silent) {
      console.log(this.formatResults(this.lastResults));
    }

    return this.lastResults;
  }

  compare(results: BenchmarkResult[] = this.lastResults): BenchmarkResult[] {
    if (results.length === 0) return results;

    const fastestAvg = Math.min(...results.map((r) => r.avgMs));
    const slowestAvg = Math.max(...results.map((r) => r.avgMs));

    return results.map((r) => ({
      ...r,
      isFastest: r.avgMs === fastestAvg,
      isSlowest: r.avgMs === slowestAvg,
    }));
  }

  formatResults(results: BenchmarkResult[] = this.lastResults): string {
    if (results.length === 0) return "(no results)";

    const nameWidth = Math.max(...results.map((r) => r.name.length), 4);

    const cols = ["name".padEnd(nameWidth), "avg (ms)".padStart(10), "min (ms)".padStart(10), "max (ms)".padStart(10), "ops/sec".padStart(12), "marker".padStart(8)];
    const header = cols.join("  ");
    const divider = "-".repeat(header.length);

    const rows = results.map((r) => {
      let marker = "";
      if (r.isFastest && results.length > 1) marker = "fastest";
      else if (r.isSlowest && results.length > 1) marker = "slowest";

      return [
        r.name.padEnd(nameWidth),
        r.avgMs.toFixed(4).padStart(10),
        r.minMs.toFixed(4).padStart(10),
        r.maxMs.toFixed(4).padStart(10),
        r.opsPerSec.toFixed(0).padStart(12),
        marker.padStart(8),
      ].join("  ");
    });

    return [header, divider, ...rows].join("\n");
  }
}
