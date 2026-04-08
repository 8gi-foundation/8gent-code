/**
 * debug-timer.ts
 * Measures and logs execution time of code blocks.
 * Supports nested timers, async profiling, aggregate stats, and flame-chart output.
 */

export interface TimerEntry {
  name: string;
  startMs: number;
  endMs?: number;
  durationMs?: number;
  parent?: string;
  depth: number;
}

export interface AggregateStats {
  name: string;
  calls: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
}

const _timers = new Map<string, TimerEntry>();
const _stack: string[] = [];
const _history: TimerEntry[] = [];
const _aggregates = new Map<string, AggregateStats>();

function _updateAggregate(entry: TimerEntry): void {
  const dur = entry.durationMs ?? 0;
  const existing = _aggregates.get(entry.name);
  if (existing) {
    existing.calls++;
    existing.totalMs += dur;
    existing.minMs = Math.min(existing.minMs, dur);
    existing.maxMs = Math.max(existing.maxMs, dur);
    existing.avgMs = existing.totalMs / existing.calls;
  } else {
    _aggregates.set(entry.name, {
      name: entry.name,
      calls: 1,
      totalMs: dur,
      minMs: dur,
      maxMs: dur,
      avgMs: dur,
    });
  }
}

/**
 * Start a named timer. Supports nesting - timers track their parent.
 */
export function timer(name: string): void {
  const parent = _stack.length > 0 ? _stack[_stack.length - 1] : undefined;
  const depth = _stack.length;
  _timers.set(name, { name, startMs: performance.now(), parent, depth });
  _stack.push(name);
}

/**
 * Stop a named timer, log its duration, and record aggregate stats.
 * Returns elapsed milliseconds.
 */
export function timerStop(name: string, log = true): number {
  const entry = _timers.get(name);
  if (!entry) {
    console.warn(`[debug-timer] No timer found for "${name}"`);
    return 0;
  }

  entry.endMs = performance.now();
  entry.durationMs = entry.endMs - entry.startMs;

  const idx = _stack.lastIndexOf(name);
  if (idx !== -1) _stack.splice(idx, 1);

  _timers.delete(name);
  _history.push({ ...entry });
  _updateAggregate(entry);

  if (log) {
    const indent = "  ".repeat(entry.depth);
    console.log(`[debug-timer] ${indent}${name}: ${entry.durationMs.toFixed(2)}ms`);
  }

  return entry.durationMs;
}

/**
 * Wrap an async function with start/stop timing. Returns the function result.
 */
export async function timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  timer(name);
  try {
    const result = await fn();
    timerStop(name);
    return result;
  } catch (err) {
    timerStop(name);
    throw err;
  }
}

/**
 * TimerReport generates flame-chart style output and aggregate stats from history.
 */
export class TimerReport {
  private history: TimerEntry[];
  private aggregates: Map<string, AggregateStats>;

  constructor(history?: TimerEntry[], aggregates?: Map<string, AggregateStats>) {
    this.history = history ?? [..._history];
    this.aggregates = aggregates ?? new Map(_aggregates);
  }

  /** Print flame-chart style output showing call tree and durations. */
  flameChart(): void {
    console.log("\n[debug-timer] --- Flame Chart ---");
    for (const entry of this.history) {
      const indent = "  ".repeat(entry.depth);
      const bar = "█".repeat(Math.min(40, Math.round((entry.durationMs ?? 0) / 5)));
      console.log(
        `${indent}${entry.name.padEnd(30 - entry.depth * 2)} ${String(entry.durationMs?.toFixed(2) ?? "?").padStart(8)}ms  ${bar}`
      );
    }
    console.log("[debug-timer] ------------------\n");
  }

  /** Print aggregate stats (calls, min, avg, max, total) sorted by total time desc. */
  aggregateStats(): void {
    const rows = [...this.aggregates.values()].sort((a, b) => b.totalMs - a.totalMs);
    console.log("\n[debug-timer] --- Aggregate Stats ---");
    console.log(
      "Name".padEnd(32) + "Calls".padStart(6) + "Total".padStart(10) + "Min".padStart(10) + "Avg".padStart(10) + "Max".padStart(10)
    );
    for (const r of rows) {
      console.log(
        r.name.padEnd(32) +
          String(r.calls).padStart(6) +
          `${r.totalMs.toFixed(1)}ms`.padStart(10) +
          `${r.minMs.toFixed(1)}ms`.padStart(10) +
          `${r.avgMs.toFixed(1)}ms`.padStart(10) +
          `${r.maxMs.toFixed(1)}ms`.padStart(10)
      );
    }
    console.log("[debug-timer] ----------------------\n");
  }

  /** Reset global history and aggregates. */
  static reset(): void {
    _history.length = 0;
    _aggregates.clear();
    _timers.clear();
    _stack.length = 0;
  }
}
