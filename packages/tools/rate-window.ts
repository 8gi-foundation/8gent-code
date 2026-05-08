/**
 * RateWindow - sliding window rate counter for monitoring request rates.
 *
 * Tracks event timestamps within a configurable time window and exposes
 * counts, rates, percentile approximations, and configurable alert thresholds.
 */

export interface RateWindowOptions {
  /** Window duration in milliseconds. Default: 60_000 (1 minute). */
  windowMs?: number;
  /** Max events to retain in memory (oldest are evicted). Default: 10_000. */
  maxEvents?: number;
  /** Alert threshold: events per window that triggers onAlert. Default: none. */
  alertThreshold?: number;
  /** Callback invoked when alert threshold is exceeded. */
  onAlert?: (rate: number, window: RateWindowSnapshot) => void;
}

export interface RateWindowSnapshot {
  /** Timestamp when snapshot was taken. */
  timestamp: number;
  /** Total events within the active window. */
  count: number;
  /** Events per second (count / windowSeconds). */
  ratePerSecond: number;
  /** Events per minute (count / windowMinutes). */
  ratePerMinute: number;
  /** Approximate 50th percentile inter-arrival gap in ms. */
  p50GapMs: number;
  /** Approximate 95th percentile inter-arrival gap in ms. */
  p95GapMs: number;
  /** Approximate 99th percentile inter-arrival gap in ms. */
  p99GapMs: number;
  /** Active window size in ms. */
  windowMs: number;
}

export class RateWindow {
  private readonly windowMs: number;
  private readonly maxEvents: number;
  private readonly alertThreshold: number | undefined;
  private readonly onAlert: RateWindowOptions["onAlert"];

  /** Ring-like array of event timestamps (epoch ms), oldest first. */
  private timestamps: number[] = [];

  constructor(options: RateWindowOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxEvents = options.maxEvents ?? 10_000;
    this.alertThreshold = options.alertThreshold;
    this.onAlert = options.onAlert;
  }

  /** Record one event at the current time (or a custom timestamp). */
  record(timestampMs: number = Date.now()): void {
    this.timestamps.push(timestampMs);

    // Evict beyond maxEvents (oldest first)
    if (this.timestamps.length > this.maxEvents) {
      this.timestamps.shift();
    }

    // Alert check
    if (this.alertThreshold !== undefined && this.onAlert) {
      const snapshot = this.snapshot(timestampMs);
      if (snapshot.count >= this.alertThreshold) {
        this.onAlert(snapshot.count, snapshot);
      }
    }
  }

  /** Prune events outside the active window relative to `now`. */
  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.timestamps.length && this.timestamps[i] < cutoff) {
      i++;
    }
    if (i > 0) {
      this.timestamps = this.timestamps.slice(i);
    }
  }

  /** Return a snapshot of current state. */
  snapshot(now: number = Date.now()): RateWindowSnapshot {
    this.prune(now);

    const count = this.timestamps.length;
    const windowSeconds = this.windowMs / 1_000;
    const windowMinutes = this.windowMs / 60_000;

    const ratePerSecond = count / windowSeconds;
    const ratePerMinute = count / windowMinutes;

    const { p50, p95, p99 } = this.computeGapPercentiles();

    return {
      timestamp: now,
      count,
      ratePerSecond,
      ratePerMinute,
      p50GapMs: p50,
      p95GapMs: p95,
      p99GapMs: p99,
      windowMs: this.windowMs,
    };
  }

  /**
   * Compute approximate inter-arrival gap percentiles from the current
   * timestamp array. Returns zeroes when fewer than 2 events exist.
   */
  private computeGapPercentiles(): { p50: number; p95: number; p99: number } {
    if (this.timestamps.length < 2) {
      return { p50: 0, p95: 0, p99: 0 };
    }

    const gaps: number[] = [];
    for (let i = 1; i < this.timestamps.length; i++) {
      gaps.push(this.timestamps[i] - this.timestamps[i - 1]);
    }
    gaps.sort((a, b) => a - b);

    const percentile = (p: number): number => {
      const idx = Math.ceil((p / 100) * gaps.length) - 1;
      return gaps[Math.max(0, Math.min(idx, gaps.length - 1))];
    };

    return {
      p50: percentile(50),
      p95: percentile(95),
      p99: percentile(99),
    };
  }

  /** Reset all recorded events. */
  reset(): void {
    this.timestamps = [];
  }

  /** Current event count inside the active window. */
  get count(): number {
    return this.snapshot().count;
  }

  /** Current events-per-second rate inside the active window. */
  get ratePerSecond(): number {
    return this.snapshot().ratePerSecond;
  }
}
