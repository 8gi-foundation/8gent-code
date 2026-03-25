/**
 * disposable-timer.ts
 *
 * DisposableTimer - tracks setTimeout, setInterval, and requestAnimationFrame
 * handles in a single registry and clears all on dispose(). Prevents timer
 * leaks when a component or scope exits before timers fire.
 *
 * Usage:
 *   using t = new DisposableTimer();           // auto-dispose with 'using'
 *   t.setTimeout(() => flush(), 300);
 *   t.setInterval(() => poll(), 1000);
 *   t.requestAnimationFrame((ts) => render(ts));
 *
 *   DisposableTimer.using((t) => { ... });     // sync scope
 *   await DisposableTimer.usingAsync(async (t) => { ... }); // async scope
 */

export type RawTimerId = ReturnType<typeof setTimeout>;
export type RafId = number;
export type AnyTimerId = RawTimerId | RafId;
export type HandleKind = "timeout" | "interval" | "raf";

export interface TimerEntry {
  id: AnyTimerId;
  kind: HandleKind;
  label: string | undefined;
  createdAt: number;
  fireCount: number;
}

export interface TimerSnapshot {
  total: number;
  timeouts: number;
  intervals: number;
  rafs: number;
  entries: ReadonlyArray<Readonly<TimerEntry>>;
}

export class DisposableTimer {
  private readonly registry = new Map<AnyTimerId, TimerEntry>();
  private _disposed = false;

  get disposed(): boolean {
    return this._disposed;
  }

  get size(): number {
    return this.registry.size;
  }

  setTimeout(fn: () => void, ms: number, label?: string): () => void {
    this.assertAlive("setTimeout");
    let id: RawTimerId;
    id = setTimeout(() => {
      const entry = this.registry.get(id);
      if (entry) entry.fireCount++;
      this.registry.delete(id);
      fn();
    }, ms);
    this.registry.set(id, { id, kind: "timeout", label, createdAt: Date.now(), fireCount: 0 });
    return () => this.clearHandle(id);
  }

  setInterval(fn: () => void, ms: number, label?: string): () => void {
    this.assertAlive("setInterval");
    const id = setInterval(() => {
      const entry = this.registry.get(id);
      if (entry) entry.fireCount++;
      fn();
    }, ms);
    this.registry.set(id, { id, kind: "interval", label, createdAt: Date.now(), fireCount: 0 });
    return () => this.clearHandle(id);
  }

  requestAnimationFrame(fn: (ts: number) => void, label?: string): () => void {
    this.assertAlive("requestAnimationFrame");
    if (typeof globalThis.requestAnimationFrame !== "function") {
      return this.setTimeout(() => fn(Date.now()), 16, label ?? "raf-polyfill");
    }
    let rafId: RafId;
    rafId = globalThis.requestAnimationFrame((ts) => {
      const entry = this.registry.get(rafId);
      if (entry) entry.fireCount++;
      this.registry.delete(rafId);
      fn(ts);
    });
    this.registry.set(rafId, { id: rafId, kind: "raf", label, createdAt: Date.now(), fireCount: 0 });
    return () => this.clearHandle(rafId);
  }

  clearHandle(id: AnyTimerId): void {
    const entry = this.registry.get(id);
    if (!entry) return;
    this.cancelEntry(entry);
    this.registry.delete(id);
  }

  snapshot(): TimerSnapshot {
    const entries = [...this.registry.values()];
    return {
      total: entries.length,
      timeouts: entries.filter((e) => e.kind === "timeout").length,
      intervals: entries.filter((e) => e.kind === "interval").length,
      rafs: entries.filter((e) => e.kind === "raf").length,
      entries: entries.map((e) => ({ ...e })),
    };
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const entry of this.registry.values()) {
      this.cancelEntry(entry);
    }
    this.registry.clear();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  static using<T>(fn: (timer: DisposableTimer) => T): T {
    const t = new DisposableTimer();
    try {
      return fn(t);
    } finally {
      t.dispose();
    }
  }

  static async usingAsync<T>(fn: (timer: DisposableTimer) => Promise<T>): Promise<T> {
    const t = new DisposableTimer();
    try {
      return await fn(t);
    } finally {
      t.dispose();
    }
  }

  private cancelEntry(entry: TimerEntry): void {
    switch (entry.kind) {
      case "timeout":
        clearTimeout(entry.id as RawTimerId);
        break;
      case "interval":
        clearInterval(entry.id as RawTimerId);
        break;
      case "raf":
        if (typeof globalThis.cancelAnimationFrame === "function") {
          globalThis.cancelAnimationFrame(entry.id as RafId);
        }
        break;
    }
  }

  private assertAlive(method: string): void {
    if (this._disposed) {
      throw new Error(`DisposableTimer.${method}: cannot schedule after dispose()`);
    }
  }
}
