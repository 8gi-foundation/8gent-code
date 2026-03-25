/**
 * perf-mark - performance.mark/measure wrapper with formatted reporting
 *
 * Wraps the Web Performance API (performance.mark/measure) with a
 * simple interface and human-readable report output.
 * Works in Bun, Node, and browser environments.
 */

export interface PerfMark {
  name: string;
  time: number;
}

export interface PerfMeasure {
  name: string;
  startMark: string;
  endMark: string | null;
  duration: number;
}

// Internal store - decoupled from browser performance API so it works in Bun/Node too
const marks = new Map<string, number>();
const measures: PerfMeasure[] = [];

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Record a named timestamp at the current moment.
 */
export function mark(name: string): void {
  marks.set(name, now());
  if (typeof performance !== "undefined" && typeof performance.mark === "function") {
    try {
      performance.mark(name);
    } catch {
      // Non-fatal - internal store is the source of truth
    }
  }
}

/**
 * Measure the duration between two marks (or from a mark to now).
 * If endMark is omitted, the current time is used as the end.
 * Returns the duration in milliseconds.
 */
export function measure(name: string, startMark: string, endMark?: string): number {
  const startTime = marks.get(startMark);
  if (startTime === undefined) {
    throw new Error(`perf-mark: no mark named "${startMark}"`);
  }

  let endTime: number;
  if (endMark) {
    const t = marks.get(endMark);
    if (t === undefined) {
      throw new Error(`perf-mark: no mark named "${endMark}"`);
    }
    endTime = t;
  } else {
    endTime = now();
  }

  const duration = endTime - startTime;

  measures.push({
    name,
    startMark,
    endMark: endMark ?? null,
    duration,
  });

  if (typeof performance !== "undefined" && typeof performance.measure === "function") {
    try {
      if (endMark) {
        performance.measure(name, startMark, endMark);
      } else {
        performance.measure(name, startMark);
      }
    } catch {
      // Non-fatal
    }
  }

  return duration;
}

/**
 * Return a snapshot of all recorded marks as an array.
 */
export function getMarks(): PerfMark[] {
  return Array.from(marks.entries()).map(([name, time]) => ({ name, time }));
}

/**
 * Return a snapshot of all recorded measures as an array.
 */
export function getMeasures(): PerfMeasure[] {
  return [...measures];
}

/**
 * Clear all marks and measures from the internal store.
 */
export function clearAll(): void {
  marks.clear();
  measures.length = 0;
  if (typeof performance !== "undefined") {
    try {
      performance.clearMarks?.();
      performance.clearMeasures?.();
    } catch {
      // Non-fatal
    }
  }
}

function formatDuration(ms: number): string {
  if (ms < 1) return `${ms.toFixed(3)}ms`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(3)}s`;
}

/**
 * Return a human-readable performance report string.
 *
 * Example output:
 *   -- perf report --
 *   Marks (3):
 *     start                0.000ms
 *     db-ready             4.200ms
 *     response-sent        21.800ms
 *
 *   Measures (2):
 *     db-query             start -> db-ready             4.20ms
 *     handler              db-ready -> response-sent     17.60ms
 */
export function report(): string {
  const lines: string[] = ["-- perf report --"];

  const markList = getMarks();
  lines.push(`Marks (${markList.length}):`);
  for (const m of markList) {
    lines.push(`  ${m.name.padEnd(20)} ${formatDuration(m.time)}`);
  }

  lines.push("");

  const measureList = getMeasures();
  lines.push(`Measures (${measureList.length}):`);
  for (const m of measureList) {
    const span = m.endMark
      ? `${m.startMark} -> ${m.endMark}`
      : `${m.startMark} -> now`;
    lines.push(`  ${m.name.padEnd(20)} ${span.padEnd(36)} ${formatDuration(m.duration)}`);
  }

  return lines.join("\n");
}
