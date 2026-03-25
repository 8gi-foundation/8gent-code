/**
 * ThrottledLogger - rate-limits repeated log messages within a configurable window.
 * Deduplicates identical messages, counts suppressed entries, and flushes
 * a summary at the end of each window.
 */

export interface ThrottledLoggerOptions {
  /** Duration in ms within which duplicate messages are deduplicated. Default: 5000 */
  windowMs?: number;
  /** Max times a unique message is emitted per window before suppression. Default: 3 */
  maxPerWindow?: number;
  /** How often (ms) to flush suppression summaries. Default: same as windowMs */
  flushIntervalMs?: number;
  /** Custom output function. Default: console.log */
  output?: (line: string) => void;
}

interface MessageState {
  count: number;
  suppressed: number;
  lastLevel: string;
}

export class ThrottledLogger {
  private windowMs: number;
  private maxPerWindow: number;
  private output: (line: string) => void;
  private window: Map<string, MessageState> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ThrottledLoggerOptions = {}) {
    this.windowMs = opts.windowMs ?? 5000;
    this.maxPerWindow = opts.maxPerWindow ?? 3;
    this.output = opts.output ?? ((line) => console.log(line));

    const flushMs = opts.flushIntervalMs ?? this.windowMs;
    this.flushTimer = setInterval(() => this.flush(), flushMs);
    // Allow process to exit even if timer is still active
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  private emit(level: string, message: string): void {
    const key = `${level}::${message}`;
    const state = this.window.get(key);

    if (!state) {
      this.window.set(key, { count: 1, suppressed: 0, lastLevel: level });
      this.output(`[${level.toUpperCase()}] ${message}`);
      return;
    }

    state.count += 1;

    if (state.count <= this.maxPerWindow) {
      this.output(`[${level.toUpperCase()}] ${message}`);
    } else {
      state.suppressed += 1;
    }
  }

  log(message: string): void {
    this.emit("log", message);
  }

  info(message: string): void {
    this.emit("info", message);
  }

  warn(message: string): void {
    this.emit("warn", message);
  }

  error(message: string): void {
    this.emit("error", message);
  }

  /**
   * Flush suppression summary for any messages that were throttled this window,
   * then reset the window counters.
   */
  flush(): void {
    for (const [key, state] of this.window.entries()) {
      if (state.suppressed > 0) {
        const [level, ...parts] = key.split("::");
        const message = parts.join("::");
        this.output(
          `[${level.toUpperCase()}] (throttled) "${message}" repeated ${state.suppressed} more time${state.suppressed === 1 ? "" : "s"} - total ${state.count}`
        );
      }
    }
    this.window.clear();
  }

  /**
   * Returns suppression stats for all tracked messages in the current window.
   */
  stats(): Array<{ message: string; level: string; count: number; suppressed: number }> {
    return Array.from(this.window.entries()).map(([key, state]) => {
      const [level, ...parts] = key.split("::");
      return {
        level,
        message: parts.join("::"),
        count: state.count,
        suppressed: state.suppressed,
      };
    });
  }

  /**
   * Stop the flush interval and perform a final flush.
   */
  destroy(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
}
