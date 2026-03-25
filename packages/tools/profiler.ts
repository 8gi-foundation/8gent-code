/**
 * 8gent Code - Function-Level Performance Profiler
 *
 * Wrap any function with timing instrumentation. Tracks call counts,
 * avg/min/max/p95 latency, and nested spans for hierarchical profiling.
 * Zero external dependencies.
 */

/** Stats snapshot for a single profiled function. */
export interface FunctionStats {
  name: string;
  calls: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p95Ms: number;
}

/** A single recorded span (one function invocation). */
export interface Span {
  name: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  parentName: string | null;
  children: Span[];
}

/** Internal per-function accumulator. */
interface Accumulator {
  name: string;
  calls: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  durations: number[];
}

/** Active span frame used during recording. */
interface ActiveFrame {
  name: string;
  startMs: number;
  parent: ActiveFrame | null;
  children: Span[];
}

/** Compute p95 from a sorted array of durations. */
function computeP95(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

/**
 * Profiler - zero-dependency function-level profiler with nested span support.
 *
 * Usage:
 *   const profiler = new Profiler();
 *
 *   // Wrap a function (sync or async):
 *   const wrappedFn = profiler.wrap("myFn", myFn);
 *
 *   // Manual span:
 *   profiler.start("mySpan");
 *   doWork();
 *   profiler.end("mySpan");
 *
 *   // Report:
 *   profiler.report();
 */
export class Profiler {
  private accumulators = new Map<string, Accumulator>();
  private activeStack: ActiveFrame[] = [];
  private completedSpans: Span[] = [];
  private enabled = true;

  /** Enable or disable all instrumentation without removing wrappers. */
  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  /** Reset all accumulated stats and spans. */
  reset(): void {
    this.accumulators.clear();
    this.activeStack = [];
    this.completedSpans = [];
  }

  /**
   * Wrap a synchronous or async function.
   * Returns a new function with the same signature.
   */
  wrap<T extends (...args: unknown[]) => unknown>(
    name: string,
    fn: T
  ): T {
    const self = this;
    const wrapped = function (this: unknown, ...args: Parameters<T>): ReturnType<T> {
      if (!self.enabled) return fn.apply(this, args) as ReturnType<T>;

      const frame = self._pushFrame(name);
      let result: ReturnType<T>;
      try {
        result = fn.apply(this, args) as ReturnType<T>;
      } catch (err) {
        self._popFrame(frame);
        throw err;
      }

      // Handle async (Promise) return.
      if (result instanceof Promise) {
        return result
          .then((v) => {
            self._popFrame(frame);
            return v;
          })
          .catch((err) => {
            self._popFrame(frame);
            throw err;
          }) as ReturnType<T>;
      }

      self._popFrame(frame);
      return result;
    };

    return wrapped as T;
  }

  /**
   * Manually start a named span.
   * Spans can be nested - call start/end in order.
   */
  start(name: string): void {
    if (!this.enabled) return;
    this._pushFrame(name);
  }

  /**
   * Manually end the most recently started span with the given name.
   * If name is omitted, ends the top of the stack.
   */
  end(name?: string): void {
    if (!this.enabled) return;
    if (this.activeStack.length === 0) return;

    if (name) {
      // Find the innermost frame matching name.
      for (let i = this.activeStack.length - 1; i >= 0; i--) {
        if (this.activeStack[i].name === name) {
          const frame = this.activeStack[i];
          this.activeStack.splice(i, 1);
          this._recordFrame(frame);
          return;
        }
      }
    } else {
      const frame = this.activeStack.pop()!;
      this._recordFrame(frame);
    }
  }

  /** Get stats for a single function by name. Returns null if not found. */
  getStats(name: string): FunctionStats | null {
    const acc = this.accumulators.get(name);
    if (!acc) return null;
    return this._toStats(acc);
  }

  /** Get stats for all profiled functions, sorted by total time descending. */
  getAllStats(): FunctionStats[] {
    return Array.from(this.accumulators.values())
      .map((acc) => this._toStats(acc))
      .sort((a, b) => b.totalMs - a.totalMs);
  }

  /** Get all completed top-level spans (with nested children). */
  getSpans(): Span[] {
    return this.completedSpans.slice();
  }

  /**
   * Print a human-readable report to the console.
   * Columns: name | calls | avg | min | max | p95 | total
   */
  report(): void {
    const stats = this.getAllStats();
    if (stats.length === 0) {
      console.log("[Profiler] No data recorded.");
      return;
    }

    const header = [
      "Function".padEnd(36),
      "Calls".padStart(7),
      "Avg(ms)".padStart(10),
      "Min(ms)".padStart(10),
      "Max(ms)".padStart(10),
      "P95(ms)".padStart(10),
      "Total(ms)".padStart(12),
    ].join("  ");

    console.log("\n[Profiler] Performance Report");
    console.log("-".repeat(header.length));
    console.log(header);
    console.log("-".repeat(header.length));

    for (const s of stats) {
      const row = [
        s.name.slice(0, 36).padEnd(36),
        String(s.calls).padStart(7),
        s.avgMs.toFixed(2).padStart(10),
        s.minMs.toFixed(2).padStart(10),
        s.maxMs.toFixed(2).padStart(10),
        s.p95Ms.toFixed(2).padStart(10),
        s.totalMs.toFixed(2).padStart(12),
      ].join("  ");
      console.log(row);
    }
    console.log("-".repeat(header.length));
    console.log();
  }

  /** Serialize all stats to a plain JSON object (useful for persisting results). */
  toJSON(): { stats: FunctionStats[]; spans: Span[] } {
    return {
      stats: this.getAllStats(),
      spans: this.getSpans(),
    };
  }

  // --- Internal helpers ---

  private _pushFrame(name: string): ActiveFrame {
    const parent = this.activeStack[this.activeStack.length - 1] ?? null;
    const frame: ActiveFrame = {
      name,
      startMs: performance.now(),
      parent,
      children: [],
    };
    this.activeStack.push(frame);
    return frame;
  }

  private _popFrame(frame: ActiveFrame): void {
    const idx = this.activeStack.lastIndexOf(frame);
    if (idx !== -1) this.activeStack.splice(idx, 1);
    this._recordFrame(frame);
  }

  private _recordFrame(frame: ActiveFrame): void {
    const endMs = performance.now();
    const durationMs = endMs - frame.startMs;

    // Accumulate stats.
    let acc = this.accumulators.get(frame.name);
    if (!acc) {
      acc = {
        name: frame.name,
        calls: 0,
        totalMs: 0,
        minMs: Infinity,
        maxMs: -Infinity,
        durations: [],
      };
      this.accumulators.set(frame.name, acc);
    }
    acc.calls++;
    acc.totalMs += durationMs;
    acc.minMs = Math.min(acc.minMs, durationMs);
    acc.maxMs = Math.max(acc.maxMs, durationMs);
    acc.durations.push(durationMs);

    // Build span.
    const span: Span = {
      name: frame.name,
      startMs: frame.startMs,
      endMs,
      durationMs,
      parentName: frame.parent?.name ?? null,
      children: frame.children,
    };

    // Attach to parent or top-level list.
    if (frame.parent) {
      frame.parent.children.push(span);
    } else {
      this.completedSpans.push(span);
    }
  }

  private _toStats(acc: Accumulator): FunctionStats {
    const sorted = acc.durations.slice().sort((a, b) => a - b);
    return {
      name: acc.name,
      calls: acc.calls,
      totalMs: acc.totalMs,
      minMs: acc.minMs === Infinity ? 0 : acc.minMs,
      maxMs: acc.maxMs === -Infinity ? 0 : acc.maxMs,
      avgMs: acc.calls > 0 ? acc.totalMs / acc.calls : 0,
      p95Ms: computeP95(sorted),
    };
  }
}

/** Module-level singleton for convenience. */
export const profiler = new Profiler();
