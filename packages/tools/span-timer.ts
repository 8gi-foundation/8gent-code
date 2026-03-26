type Span = {
  name: string;
  startMs: number;
  durationMs: number;
};

let active: { [id: string]: Span & { end(): void } } = {};
let completed: Span[] = [];

/**
 * Start a named time span.
 * @param name - The name of the span.
 * @returns A span object with end() method.
 */
function startSpan(name: string): Span & { end(): void } {
  const id = Math.random().toString(36).substring(2, 9);
  const span: Span & { end(): void } = {
    name,
    startMs: Date.now(),
    durationMs: 0,
    end: () => {
      const now = Date.now();
      span.durationMs = now - span.startMs;
      completed.push({ ...span });
      delete active[id];
    }
  };
  active[id] = span;
  return span;
}

/**
 * Get all completed spans.
 * @returns Array of completed spans.
 */
function getSpans(): Span[] {
  return completed;
}

/**
 * Reset all spans.
 */
function reset(): void {
  active = {};
  completed = [];
}

export { startSpan, getSpans, reset };