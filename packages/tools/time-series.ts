/**
 * TimeSeries - time-series data storage with range queries, window aggregations,
 * and downsampling for agent metrics and telemetry.
 */

export interface DataPoint {
  timestamp: number;
  value: number;
}

type AggFn = "avg" | "min" | "max" | "sum" | "count";

export class TimeSeries {
  private points: DataPoint[] = [];

  /** Add a data point. Timestamp defaults to Date.now(). */
  add(value: number, timestamp: number = Date.now()): void {
    const point: DataPoint = { timestamp, value };
    // Binary insert to keep sorted by timestamp
    let lo = 0;
    let hi = this.points.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.points[mid].timestamp <= timestamp) lo = mid + 1;
      else hi = mid;
    }
    this.points.splice(lo, 0, point);
  }

  /** Return all points in [from, to] inclusive (timestamps in ms). */
  range(from: number, to: number): DataPoint[] {
    return this.points.filter((p) => p.timestamp >= from && p.timestamp <= to);
  }

  /** Return the latest n points (most recent first). */
  latest(n: number): DataPoint[] {
    return this.points.slice(-n).reverse();
  }

  /** Clear all stored points. */
  clear(): void {
    this.points = [];
  }

  /** Total number of stored points. */
  get size(): number {
    return this.points.length;
  }

  // --- Window helpers ---

  private windowPoints(windowMs: number): DataPoint[] {
    const cutoff = Date.now() - windowMs;
    return this.points.filter((p) => p.timestamp >= cutoff);
  }

  /** Average value over a trailing window (ms). Returns NaN if no data. */
  avg(windowMs: number): number {
    const pts = this.windowPoints(windowMs);
    if (pts.length === 0) return NaN;
    return pts.reduce((s, p) => s + p.value, 0) / pts.length;
  }

  /** Minimum value over a trailing window (ms). Returns NaN if no data. */
  min(windowMs: number): number {
    const pts = this.windowPoints(windowMs);
    if (pts.length === 0) return NaN;
    return Math.min(...pts.map((p) => p.value));
  }

  /** Maximum value over a trailing window (ms). Returns NaN if no data. */
  max(windowMs: number): number {
    const pts = this.windowPoints(windowMs);
    if (pts.length === 0) return NaN;
    return Math.max(...pts.map((p) => p.value));
  }

  /** Sum of values over a trailing window (ms). Returns 0 if no data. */
  sum(windowMs: number): number {
    return this.windowPoints(windowMs).reduce((s, p) => s + p.value, 0);
  }

  /**
   * Downsample by bucketing points into fixed-size intervals.
   * Each bucket is reduced using fn (default: avg).
   * Returns one DataPoint per occupied bucket (timestamp = bucket start).
   */
  downsample(intervalMs: number, fn: AggFn = "avg"): DataPoint[] {
    if (this.points.length === 0) return [];

    const buckets = new Map<number, number[]>();
    for (const p of this.points) {
      const bucket = Math.floor(p.timestamp / intervalMs) * intervalMs;
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket)!.push(p.value);
    }

    const result: DataPoint[] = [];
    for (const [timestamp, values] of Array.from(buckets.entries()).sort(
      (a, b) => a[0] - b[0]
    )) {
      let value: number;
      switch (fn) {
        case "avg":
          value = values.reduce((s, v) => s + v, 0) / values.length;
          break;
        case "min":
          value = Math.min(...values);
          break;
        case "max":
          value = Math.max(...values);
          break;
        case "sum":
          value = values.reduce((s, v) => s + v, 0);
          break;
        case "count":
          value = values.length;
          break;
        default:
          value = values[0];
      }
      result.push({ timestamp, value });
    }
    return result;
  }
}
