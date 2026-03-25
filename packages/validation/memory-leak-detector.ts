/**
 * Memory Leak Detector
 *
 * Monitors process.memoryUsage() over long-running sessions,
 * detects upward trends indicating leaks, and reports heap
 * growth rate with suspicious patterns.
 */

export interface MemSample {
  ts: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
}

export interface LeakReport {
  samples: number;
  durationMs: number;
  heapGrowthBytes: number;
  heapGrowthRate: number; // bytes per second
  rssGrowthBytes: number;
  trending: boolean;
  suspiciousPatterns: string[];
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_WINDOW = 120; // max samples kept
const TREND_THRESHOLD = 0.75; // fraction of intervals that must grow to flag

export class MemoryLeakDetector {
  private samples: MemSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly maxSamples: number;

  constructor(opts?: { intervalMs?: number; maxSamples?: number }) {
    this.intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxSamples = opts?.maxSamples ?? DEFAULT_WINDOW;
  }

  /** Take a single snapshot and store it. */
  sample(): MemSample {
    const mem = process.memoryUsage();
    const s: MemSample = {
      ts: Date.now(),
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external,
    };
    this.samples.push(s);
    if (this.samples.length > this.maxSamples) this.samples.shift();
    return s;
  }

  /** Start periodic sampling. */
  start(): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
  }

  /** Stop periodic sampling. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Analyze collected samples and produce a report. */
  report(): LeakReport {
    const n = this.samples.length;
    const patterns: string[] = [];

    if (n < 2) {
      return {
        samples: n,
        durationMs: 0,
        heapGrowthBytes: 0,
        heapGrowthRate: 0,
        rssGrowthBytes: 0,
        trending: false,
        suspiciousPatterns: ["insufficient samples"],
      };
    }

    const first = this.samples[0];
    const last = this.samples[n - 1];
    const durationMs = last.ts - first.ts;
    const durationSec = durationMs / 1000 || 1;
    const heapGrowth = last.heapUsed - first.heapUsed;
    const rssGrowth = last.rss - first.rss;
    const heapRate = heapGrowth / durationSec;

    // Count monotonic increases between consecutive samples
    let rises = 0;
    for (let i = 1; i < n; i++) {
      if (this.samples[i].heapUsed > this.samples[i - 1].heapUsed) rises++;
    }
    const riseFraction = rises / (n - 1);
    const trending = riseFraction >= TREND_THRESHOLD;

    if (trending) patterns.push(`heap rising in ${(riseFraction * 100).toFixed(0)}% of intervals`);
    if (heapRate > 1_000_000) patterns.push(`heap growing at ${(heapRate / 1e6).toFixed(2)} MB/s`);
    if (last.heapTotal > first.heapTotal * 1.5) patterns.push("heapTotal expanded >50%");
    if (last.external > first.external + 10_000_000) patterns.push("external memory grew >10 MB");
    if (rssGrowth > 100_000_000) patterns.push("RSS grew >100 MB");

    return {
      samples: n,
      durationMs,
      heapGrowthBytes: heapGrowth,
      heapGrowthRate: heapRate,
      rssGrowthBytes: rssGrowth,
      trending,
      suspiciousPatterns: patterns,
    };
  }

  /** Reset all collected samples. */
  reset(): void {
    this.samples = [];
  }
}
