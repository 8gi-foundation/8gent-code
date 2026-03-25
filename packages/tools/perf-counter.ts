/**
 * perf-counter - class-based performance counter with named checkpoints
 *
 * Distinct from perf-mark.ts (module-level Web Perf API wrapper).
 * PerfCounter is instance-based: create one per operation, nest them,
 * checkpoint key stages, and get a formatted summary at the end.
 *
 * Usage:
 *   const c = perf("request");
 *   c.start();
 *   // ... work ...
 *   c.checkpoint("db");
 *   // ... work ...
 *   c.checkpoint("render");
 *   c.stop();
 *   console.log(c.format());
 */

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function fmtMs(ms: number): string {
  if (ms < 1) return `${ms.toFixed(3)}ms`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(3)}s`;
}

export interface Checkpoint {
  name: string;
  /** Absolute timestamp (ms from process start or epoch) */
  at: number;
  /** Time since counter started (ms) */
  elapsed: number;
  /** Time since the previous checkpoint (or start) */
  delta: number;
}

export interface PerfSummary {
  name: string;
  totalMs: number;
  checkpoints: Checkpoint[];
  children: PerfSummary[];
}

export class PerfCounter {
  private _name: string;
  private _startAt: number | null = null;
  private _stopAt: number | null = null;
  private _checkpoints: Checkpoint[] = [];
  private _children: PerfCounter[] = [];
  private _autoLog: boolean;
  private _lastAt: number | null = null;

  constructor(name: string, autoLog = false) {
    this._name = name;
    this._autoLog = autoLog;
  }

  /** Begin timing. Idempotent - calling again resets the counter. */
  start(): this {
    this._startAt = now();
    this._stopAt = null;
    this._lastAt = this._startAt;
    this._checkpoints = [];
    return this;
  }

  /**
   * Record a named checkpoint.
   * Implicitly calls start() if not already started.
   */
  checkpoint(name: string): this {
    if (this._startAt === null) this.start();
    const at = now();
    const elapsed = at - this._startAt!;
    const delta = at - this._lastAt!;
    this._lastAt = at;
    const cp: Checkpoint = { name, at, elapsed, delta };
    this._checkpoints.push(cp);
    if (this._autoLog) {
      console.log(`[${this._name}] ${name}: +${fmtMs(delta)} (${fmtMs(elapsed)} total)`);
    }
    return this;
  }

  /** Stop timing. Returns total elapsed ms. */
  stop(): number {
    if (this._startAt === null) return 0;
    this._stopAt = now();
    const total = this._stopAt - this._startAt;
    if (this._autoLog) {
      console.log(`[${this._name}] done: ${fmtMs(total)}`);
    }
    return total;
  }

  /** Total elapsed ms from start to stop (or now if still running). */
  elapsed(): number {
    if (this._startAt === null) return 0;
    return (this._stopAt ?? now()) - this._startAt;
  }

  /** Snapshot of all recorded checkpoints. */
  checkpoints(): readonly Checkpoint[] {
    return this._checkpoints;
  }

  /**
   * Create and register a nested child counter.
   * Children appear indented in format() output.
   */
  child(name: string, autoLog = false): PerfCounter {
    const c = new PerfCounter(name, autoLog);
    this._children.push(c);
    return c;
  }

  /** Reset all state. */
  reset(): this {
    this._startAt = null;
    this._stopAt = null;
    this._lastAt = null;
    this._checkpoints = [];
    this._children = [];
    return this;
  }

  /** Structured summary (useful for JSON serialization or tests). */
  summary(): PerfSummary {
    return {
      name: this._name,
      totalMs: this.elapsed(),
      checkpoints: [...this._checkpoints],
      children: this._children.map((c) => c.summary()),
    };
  }

  /** Human-readable formatted output. */
  format(indent = 0): string {
    const pad = "  ".repeat(indent);
    const total = this.elapsed();
    const lines: string[] = [`${pad}[${this._name}] ${fmtMs(total)}`];

    for (const cp of this._checkpoints) {
      lines.push(`${pad}  ${cp.name.padEnd(24)} +${fmtMs(cp.delta).padStart(10)}   (${fmtMs(cp.elapsed)} elapsed)`);
    }

    for (const child of this._children) {
      lines.push(child.format(indent + 1));
    }

    return lines.join("\n");
  }
}

/**
 * Factory: create and immediately start a named counter.
 *
 *   const c = perf("db-query");
 *   // ... work ...
 *   c.stop();
 *   console.log(c.format());
 */
export function perf(name: string, autoLog = false): PerfCounter {
  return new PerfCounter(name, autoLog).start();
}
