/**
 * EventAggregator - time-window analytics for agent events.
 * Tracks event occurrences and numeric values across configurable windows.
 */

export type TimeWindow = "1m" | "5m" | "1h" | "1d";

const WINDOW_MS: Record<TimeWindow, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
};

interface Entry {
  ts: number;
  value: number;
}

export class EventAggregator {
  private store = new Map<string, Entry[]>();

  /**
   * Record an event occurrence. Value defaults to 1 (for counting).
   */
  record(event: string, value = 1): void {
    const now = Date.now();
    if (!this.store.has(event)) {
      this.store.set(event, []);
    }
    this.store.get(event)!.push({ ts: now, value });
    this.trim(event);
  }

  /** Number of occurrences in window. */
  count(event: string, window: TimeWindow): number {
    return this.entries(event, window).length;
  }

  /** Sum of values in window. */
  sum(event: string, window: TimeWindow): number {
    return this.entries(event, window).reduce((acc, e) => acc + e.value, 0);
  }

  /** Average value in window, or 0 if no entries. */
  avg(event: string, window: TimeWindow): number {
    const entries = this.entries(event, window);
    if (entries.length === 0) return 0;
    return this.sum(event, window) / entries.length;
  }

  /**
   * Rate of occurrences per second over the window.
   * Returns 0 if window has no data.
   */
  rate(event: string, window: TimeWindow): number {
    const n = this.count(event, window);
    if (n === 0) return 0;
    return n / (WINDOW_MS[window] / 1000);
  }

  /**
   * Top N events by occurrence count in the given window.
   * Returns array of [event, count] pairs, descending.
   */
  topN(n: number, window: TimeWindow): Array<[string, number]> {
    const results: Array<[string, number]> = [];
    for (const event of this.store.keys()) {
      results.push([event, this.count(event, window)]);
    }
    return results.sort((a, b) => b[1] - a[1]).slice(0, n);
  }

  /** All event names tracked. */
  events(): string[] {
    return Array.from(this.store.keys());
  }

  /** Snapshot of all events with count for a given window. */
  snapshot(window: TimeWindow): Record<string, number> {
    const out: Record<string, number> = {};
    for (const event of this.store.keys()) {
      out[event] = this.count(event, window);
    }
    return out;
  }

  /** Clear all recorded data. */
  reset(): void {
    this.store.clear();
  }

  // --- internal ---

  private entries(event: string, window: TimeWindow): Entry[] {
    const cutoff = Date.now() - WINDOW_MS[window];
    return (this.store.get(event) ?? []).filter((e) => e.ts >= cutoff);
  }

  /** Prune entries older than the largest window (1d) to avoid unbounded growth. */
  private trim(event: string): void {
    const cutoff = Date.now() - WINDOW_MS["1d"];
    const entries = this.store.get(event)!;
    const idx = entries.findIndex((e) => e.ts >= cutoff);
    if (idx > 0) {
      this.store.set(event, entries.slice(idx));
    } else if (idx === -1) {
      this.store.set(event, []);
    }
  }
}
