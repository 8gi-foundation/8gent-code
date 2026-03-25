/**
 * Event Timeline Tool
 * Records timestamped events and spans, renders ASCII timeline visualization.
 * Useful for agent session debugging and performance tracing.
 */

export interface TimelineMark {
  name: string;
  ts: number; // ms since timeline start
  data?: Record<string, unknown>;
}

export interface TimelineSpan {
  name: string;
  start: number; // ms since timeline start
  end: number;   // ms since timeline start
  durationMs: number;
  data?: Record<string, unknown>;
}

export class Timeline {
  private origin: number;
  private marks: TimelineMark[] = [];
  private spans: TimelineSpan[] = [];

  constructor() {
    this.origin = Date.now();
  }

  /** Record a named point in time with optional metadata. */
  mark(name: string, data?: Record<string, unknown>): void {
    this.marks.push({ name, ts: Date.now() - this.origin, data });
  }

  /**
   * Wrap a sync or async function as a named span.
   * Returns the function's return value unchanged.
   */
  async span<T>(name: string, fn: () => T | Promise<T>, data?: Record<string, unknown>): Promise<T> {
    const start = Date.now() - this.origin;
    const result = await fn();
    const end = Date.now() - this.origin;
    this.spans.push({ name, start, end, durationMs: end - start, data });
    return result;
  }

  /** All recorded marks in insertion order. */
  getMarks(): TimelineMark[] {
    return [...this.marks];
  }

  /** All recorded spans in insertion order. */
  getSpans(): TimelineSpan[] {
    return [...this.spans];
  }

  /** Total elapsed ms since the timeline was created. */
  duration(): number {
    return Date.now() - this.origin;
  }

  /**
   * ASCII timeline visualization.
   * Marks: vertical bar at position, spans: horizontal bar across duration.
   * Width: number of characters representing the full timeline (default 60).
   */
  format(width = 60): string {
    const total = this.duration();
    if (total === 0) return "(empty timeline)";

    const scale = (ms: number): number => Math.round((ms / total) * (width - 1));
    const lines: string[] = [];

    lines.push(`Timeline [0ms - ${total}ms]`);
    lines.push("─".repeat(width));

    // Marks
    for (const m of this.marks) {
      const pos = scale(m.ts);
      const bar = " ".repeat(pos) + "|";
      const label = `  ${m.name} @${m.ts}ms`;
      lines.push(bar + label);
    }

    // Spans
    for (const s of this.spans) {
      const startPos = scale(s.start);
      const endPos = scale(s.end);
      const spanLen = Math.max(1, endPos - startPos);
      const bar =
        " ".repeat(startPos) +
        "[" +
        "=".repeat(Math.max(0, spanLen - 2)) +
        "]";
      const label = `  ${s.name} (${s.durationMs}ms)`;
      lines.push(bar + label);
    }

    lines.push("─".repeat(width));
    lines.push(`${this.marks.length} mark(s), ${this.spans.length} span(s), total ${total}ms`);

    return lines.join("\n");
  }

  /** Reset the timeline - clears all marks and spans, resets origin. */
  reset(): void {
    this.origin = Date.now();
    this.marks = [];
    this.spans = [];
  }
}

// Convenience singleton for quick one-off use
export const timeline = new Timeline();
