/**
 * IntervalScheduler - manages multiple named intervals with drift correction.
 *
 * Uses a setTimeout chain instead of setInterval to avoid timer drift.
 * Each tick schedules the next tick based on elapsed time, keeping intervals accurate.
 */

export interface ScheduledInterval {
  name: string;
  fn: () => void | Promise<void>;
  ms: number;
  paused: boolean;
  lastTick: number;
  tickCount: number;
  handle: ReturnType<typeof setTimeout> | null;
}

export class IntervalScheduler {
  private intervals: Map<string, ScheduledInterval> = new Map();

  /**
   * Add a named interval. Replaces any existing interval with the same name.
   */
  add(name: string, fn: () => void | Promise<void>, ms: number): this {
    if (this.intervals.has(name)) {
      this.remove(name);
    }

    const entry: ScheduledInterval = {
      name,
      fn,
      ms,
      paused: false,
      lastTick: Date.now(),
      tickCount: 0,
      handle: null,
    };

    this.intervals.set(name, entry);
    this._schedule(entry);
    return this;
  }

  /**
   * Remove a named interval, cancelling any pending tick.
   */
  remove(name: string): boolean {
    const entry = this.intervals.get(name);
    if (!entry) return false;

    if (entry.handle !== null) {
      clearTimeout(entry.handle);
      entry.handle = null;
    }

    this.intervals.delete(name);
    return true;
  }

  /**
   * Pause a named interval. The pending tick is cancelled; tick count is preserved.
   */
  pause(name: string): boolean {
    const entry = this.intervals.get(name);
    if (!entry || entry.paused) return false;

    if (entry.handle !== null) {
      clearTimeout(entry.handle);
      entry.handle = null;
    }

    entry.paused = true;
    return true;
  }

  /**
   * Resume a paused interval. Schedules the next tick from now.
   */
  resume(name: string): boolean {
    const entry = this.intervals.get(name);
    if (!entry || !entry.paused) return false;

    entry.paused = false;
    entry.lastTick = Date.now();
    this._schedule(entry);
    return true;
  }

  /**
   * Pause all active intervals.
   */
  pauseAll(): void {
    for (const name of this.intervals.keys()) {
      this.pause(name);
    }
  }

  /**
   * Resume all paused intervals.
   */
  resumeAll(): void {
    for (const name of this.intervals.keys()) {
      this.resume(name);
    }
  }

  /**
   * List all registered intervals with their current state.
   */
  list(): Array<{ name: string; ms: number; paused: boolean; tickCount: number }> {
    return Array.from(this.intervals.values()).map(({ name, ms, paused, tickCount }) => ({
      name,
      ms,
      paused,
      tickCount,
    }));
  }

  /**
   * Remove all intervals.
   */
  clear(): void {
    for (const name of [...this.intervals.keys()]) {
      this.remove(name);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private _schedule(entry: ScheduledInterval): void {
    const drift = Date.now() - entry.lastTick;
    const delay = Math.max(0, entry.ms - drift);

    entry.handle = setTimeout(() => {
      if (!this.intervals.has(entry.name) || entry.paused) return;

      entry.lastTick = Date.now();
      entry.tickCount += 1;
      entry.handle = null;

      try {
        const result = entry.fn();
        if (result instanceof Promise) {
          result.catch((err) => {
            // Surface async errors without crashing the scheduler
            console.error(`[IntervalScheduler] "${entry.name}" threw:`, err);
          });
        }
      } catch (err) {
        console.error(`[IntervalScheduler] "${entry.name}" threw:`, err);
      }

      // Reschedule unless removed inside the tick
      if (this.intervals.has(entry.name) && !entry.paused) {
        this._schedule(entry);
      }
    }, delay);
  }
}
