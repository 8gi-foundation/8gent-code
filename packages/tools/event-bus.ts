/**
 * Typed event bus with wildcard subscriptions and history replay.
 * ~80 lines. Zero dependencies.
 */

type Handler<T = unknown> = (payload: T) => void;

interface HistoryEntry<T = unknown> {
  event: string;
  payload: T;
  ts: number;
}

export class EventBus<Events extends Record<string, unknown> = Record<string, unknown>> {
  private listeners = new Map<string, Set<Handler>>();
  private history: HistoryEntry[] = [];
  private maxHistory: number;

  constructor(opts?: { maxHistory?: number }) {
    this.maxHistory = opts?.maxHistory ?? 200;
  }

  /** Subscribe to an event. Supports wildcards: "file.*" matches "file.open", "file.close". */
  subscribe<K extends string & keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler as Handler);
    return () => this.off(event, handler);
  }

  /** Alias for subscribe. */
  on<K extends string & keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    return this.subscribe(event, handler);
  }

  /** Subscribe once - auto-removes after first call. */
  once<K extends string & keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    const wrapper: Handler<Events[K]> = (payload) => {
      this.off(event, wrapper);
      handler(payload);
    };
    return this.subscribe(event, wrapper);
  }

  /** Remove a specific handler. */
  off<K extends string & keyof Events>(event: K, handler: Handler<Events[K]>): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(handler as Handler);
      if (set.size === 0) this.listeners.delete(event);
    }
  }

  /** Emit an event to all matching listeners (exact + wildcard). */
  emit<K extends string & keyof Events>(event: K, payload: Events[K]): void {
    this.history.push({ event, payload, ts: Date.now() });
    if (this.history.length > this.maxHistory) this.history.shift();

    for (const [pattern, handlers] of this.listeners) {
      if (this.matches(pattern, event)) {
        for (const h of handlers) h(payload);
      }
    }
  }

  /** Replay history for a pattern, optionally filtered by time window (ms). */
  replay<K extends string & keyof Events>(
    pattern: K,
    handler: Handler<Events[K]>,
    since?: number,
  ): void {
    const cutoff = since ? Date.now() - since : 0;
    for (const entry of this.history) {
      if (entry.ts >= cutoff && this.matches(pattern, entry.event)) {
        handler(entry.payload as Events[K]);
      }
    }
  }

  /** Clear all listeners and history. */
  clear(): void {
    this.listeners.clear();
    this.history = [];
  }

  /** Match pattern against event name. "*" segments match any single segment. */
  private matches(pattern: string, event: string): boolean {
    if (pattern === event || pattern === "*") return true;
    const pParts = pattern.split(".");
    const eParts = event.split(".");
    if (pParts.length !== eParts.length) return false;
    return pParts.every((p, i) => p === "*" || p === eParts[i]);
  }
}
