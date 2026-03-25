/**
 * sandboxed-timer.ts
 *
 * TimerScope - a container for setTimeout/setInterval handles that auto-cancels
 * all registered timers on dispose. Prevents timer leaks when a feature or
 * request scope exits before timers fire.
 *
 * Usage:
 *   using scope = new TimerScope();               // auto-dispose with 'using'
 *   scope.timeout(() => doWork(), 500);
 *   scope.interval(() => poll(), 1000);
 *   scope.dispose();                               // or explicit dispose
 *
 * All pending timers are cleared on dispose regardless of whether they fired.
 */

export type TimerId = ReturnType<typeof setTimeout>;

export interface TimerHandle {
  id: TimerId;
  kind: "timeout" | "interval";
  /** label for debug/introspection */
  label?: string;
}

export class TimerScope {
  private readonly handles = new Map<TimerId, TimerHandle>();
  private disposed = false;

  /** Schedule a one-shot timer. Returns cancel function. */
  timeout(fn: () => void, delayMs: number, label?: string): () => void {
    this.assertAlive();
    let id: TimerId;
    id = setTimeout(() => {
      this.handles.delete(id);
      fn();
    }, delayMs);
    this.handles.set(id, { id, kind: "timeout", label });
    return () => this.cancel(id);
  }

  /** Schedule a repeating interval. Returns cancel function. */
  interval(fn: () => void, periodMs: number, label?: string): () => void {
    this.assertAlive();
    const id = setInterval(fn, periodMs);
    this.handles.set(id, { id, kind: "interval", label });
    return () => this.cancel(id);
  }

  /** Cancel a single timer by its id. No-op if already fired/cancelled. */
  cancel(id: TimerId): void {
    const handle = this.handles.get(id);
    if (!handle) return;
    if (handle.kind === "timeout") {
      clearTimeout(id);
    } else {
      clearInterval(id);
    }
    this.handles.delete(id);
  }

  /** How many timers are currently pending. */
  get size(): number {
    return this.handles.size;
  }

  /** Labels of all currently pending timers (for debugging). */
  get pendingLabels(): string[] {
    return [...this.handles.values()]
      .map((h) => h.label ?? `${h.kind}:${String(h.id)}`)
      .filter(Boolean);
  }

  /** Cancel all pending timers and mark scope as disposed. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const handle of this.handles.values()) {
      if (handle.kind === "timeout") {
        clearTimeout(handle.id);
      } else {
        clearInterval(handle.id);
      }
    }
    this.handles.clear();
  }

  /**
   * Symbol.dispose - enables 'using scope = new TimerScope()' in TS 5.2+.
   * Automatically called when the block exits, even on throw.
   */
  [Symbol.dispose](): void {
    this.dispose();
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error("TimerScope: cannot schedule timers after dispose");
    }
  }
}

/**
 * Convenience factory - creates a scope, runs the callback, disposes when done.
 * Async-safe: awaits the callback before disposing.
 *
 * Example:
 *   await withTimerScope(async (scope) => {
 *     scope.interval(() => heartbeat(), 5000, "heartbeat");
 *     await doWork();
 *   }); // all timers cancelled here
 */
export async function withTimerScope<T>(
  fn: (scope: TimerScope) => Promise<T>
): Promise<T> {
  const scope = new TimerScope();
  try {
    return await fn(scope);
  } finally {
    scope.dispose();
  }
}
