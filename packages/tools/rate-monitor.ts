/**
 * RateMonitor - sliding window event rate tracking with threshold alerts.
 *
 * Multiple named counters. Each counter maintains a circular buffer of
 * timestamped events within a configurable window. Thresholds fire a
 * callback when rate goes outside the [min, max] band.
 */

export interface RateStats {
  count: number;
  rate: number; // events per second over the window
  windowMs: number;
  oldest: number | null; // timestamp of oldest event in window
  newest: number | null; // timestamp of newest event in window
}

interface ThresholdConfig {
  min: number; // minimum acceptable rate (events/sec). 0 = no lower bound.
  max: number; // maximum acceptable rate (events/sec). Infinity = no upper bound.
  callback: (name: string, rate: number, stats: RateStats) => void;
}

interface CounterState {
  events: number[]; // chronological buffer of timestamps (ms)
  threshold: ThresholdConfig | null;
  windowMs: number;
  lastAlertRate: number | null;
}

const DEFAULT_WINDOW_MS = 60_000; // 1 minute

export class RateMonitor {
  private counters = new Map<string, CounterState>();

  private getOrCreate(name: string): CounterState {
    if (!this.counters.has(name)) {
      this.counters.set(name, {
        events: [],
        threshold: null,
        windowMs: DEFAULT_WINDOW_MS,
        lastAlertRate: null,
      });
    }
    return this.counters.get(name)!;
  }

  /**
   * Record one or more events for a named counter.
   * @param name - counter name
   * @param count - number of events to record (default 1)
   * @param windowMs - optional override for this counter's sliding window
   */
  record(name: string, count = 1, windowMs?: number): void {
    const state = this.getOrCreate(name);
    if (windowMs !== undefined) state.windowMs = windowMs;

    const now = Date.now();
    for (let i = 0; i < count; i++) {
      state.events.push(now);
    }

    this.prune(state, now);
    this.checkThreshold(name, state);
  }

  /**
   * Current rate for a named counter.
   * @param name - counter name
   * @param windowMs - optional window override (does not persist)
   * @returns events per second over the window
   */
  rate(name: string, windowMs?: number): number {
    const state = this.counters.get(name);
    if (!state || state.events.length === 0) return 0;

    const win = windowMs ?? state.windowMs;
    const now = Date.now();
    const cutoff = now - win;
    const visible = state.events.filter((t) => t >= cutoff);
    return visible.length > 0 ? (visible.length / win) * 1000 : 0;
  }

  /**
   * Set an alert threshold for a named counter.
   * Fires callback whenever rate falls outside [min, max].
   * Pass min=0 / max=Infinity to only enforce one bound.
   */
  setThreshold(
    name: string,
    min: number,
    max: number,
    callback: (name: string, rate: number, stats: RateStats) => void
  ): void {
    const state = this.getOrCreate(name);
    state.threshold = { min, max, callback };
    state.lastAlertRate = null;
  }

  /**
   * Remove threshold from a counter without clearing its events.
   */
  clearThreshold(name: string): void {
    const state = this.counters.get(name);
    if (state) {
      state.threshold = null;
      state.lastAlertRate = null;
    }
  }

  /**
   * Reset a single counter (clears events + threshold).
   * Omit name to reset all counters.
   */
  reset(name?: string): void {
    if (name !== undefined) {
      this.counters.delete(name);
    } else {
      this.counters.clear();
    }
  }

  /**
   * Full stats snapshot for a named counter.
   */
  stats(name: string): RateStats {
    const state = this.counters.get(name);
    if (!state || state.events.length === 0) {
      return { count: 0, rate: 0, windowMs: DEFAULT_WINDOW_MS, oldest: null, newest: null };
    }

    const now = Date.now();
    this.prune(state, now);
    const { events, windowMs } = state;

    return {
      count: events.length,
      rate: events.length > 0 ? (events.length / windowMs) * 1000 : 0,
      windowMs,
      oldest: events.length > 0 ? events[0] : null,
      newest: events.length > 0 ? events[events.length - 1] : null,
    };
  }

  /**
   * All counter names currently tracked.
   */
  names(): string[] {
    return Array.from(this.counters.keys());
  }

  // --- private helpers ---

  private prune(state: CounterState, now: number): void {
    const cutoff = now - state.windowMs;
    let i = 0;
    while (i < state.events.length && state.events[i] < cutoff) i++;
    if (i > 0) state.events.splice(0, i);
  }

  private checkThreshold(name: string, state: CounterState): void {
    if (!state.threshold) return;

    const currentRate =
      state.events.length > 0 ? (state.events.length / state.windowMs) * 1000 : 0;

    const { min, max, callback } = state.threshold;
    if (currentRate < min || currentRate > max) {
      state.lastAlertRate = currentRate;
      callback(name, currentRate, this.stats(name));
    } else {
      state.lastAlertRate = null;
    }
  }
}
