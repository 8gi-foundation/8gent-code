/**
 * TypedEventBus - type-safe event bus with wildcards, once listeners,
 * event history buffer, and async handlers. Zero dependencies.
 */

export type EventMap = Record<string, unknown>;

export type Handler<T> = (payload: T) => void | Promise<void>;

export interface HistoryEntry<T = unknown> {
  event: string;
  payload: T;
  timestamp: number;
}

interface ListenerEntry<T> {
  handler: Handler<T>;
  once: boolean;
}

export class TypedEventBus<Events extends EventMap = EventMap> {
  private listeners = new Map<string, ListenerEntry<unknown>[]>();
  private wildcardListeners: ListenerEntry<{ event: string; payload: unknown }>[] = [];
  private history: HistoryEntry[] = [];
  private readonly historyLimit: number;

  constructor(options: { historyLimit?: number } = {}) {
    this.historyLimit = options.historyLimit ?? 100;
  }

  /**
   * Subscribe to a specific event.
   * Returns an unsubscribe function.
   */
  on<K extends keyof Events & string>(
    event: K,
    handler: Handler<Events[K]>
  ): () => void {
    return this._addListener(event, handler as Handler<unknown>, false);
  }

  /**
   * Subscribe to all events via wildcard "*".
   * Handler receives { event, payload }.
   */
  onWildcard(
    handler: Handler<{ event: string; payload: unknown }>
  ): () => void {
    const entry: ListenerEntry<{ event: string; payload: unknown }> = {
      handler,
      once: false,
    };
    this.wildcardListeners.push(entry);
    return () => {
      const idx = this.wildcardListeners.indexOf(entry);
      if (idx !== -1) this.wildcardListeners.splice(idx, 1);
    };
  }

  /**
   * Subscribe to a specific event once - auto-removes after first fire.
   * Returns an unsubscribe function.
   */
  once<K extends keyof Events & string>(
    event: K,
    handler: Handler<Events[K]>
  ): () => void {
    return this._addListener(event, handler as Handler<unknown>, true);
  }

  /**
   * Returns a Promise that resolves with the next emission of the event.
   */
  next<K extends keyof Events & string>(event: K): Promise<Events[K]> {
    return new Promise((resolve) => {
      this.once(event, resolve as Handler<Events[K]>);
    });
  }

  /**
   * Emit an event. All matching handlers are called.
   * Returns a Promise that resolves when all async handlers settle.
   */
  async emit<K extends keyof Events & string>(
    event: K,
    payload: Events[K]
  ): Promise<void> {
    // Record history
    const entry: HistoryEntry = { event, payload, timestamp: Date.now() };
    this.history.push(entry);
    if (this.history.length > this.historyLimit) {
      this.history.shift();
    }

    const bucket = this.listeners.get(event);
    const promises: Promise<void>[] = [];

    if (bucket) {
      const toRemove: ListenerEntry<unknown>[] = [];
      for (const item of [...bucket]) {
        if (item.once) toRemove.push(item);
        const result = item.handler(payload);
        if (result instanceof Promise) promises.push(result);
      }
      for (const item of toRemove) {
        const idx = bucket.indexOf(item);
        if (idx !== -1) bucket.splice(idx, 1);
      }
      if (bucket.length === 0) this.listeners.delete(event);
    }

    // Wildcard handlers
    const wildcardPayload = { event, payload };
    const toRemoveWild: ListenerEntry<{ event: string; payload: unknown }>[] = [];
    for (const item of [...this.wildcardListeners]) {
      if (item.once) toRemoveWild.push(item);
      const result = item.handler(wildcardPayload);
      if (result instanceof Promise) promises.push(result);
    }
    for (const item of toRemoveWild) {
      const idx = this.wildcardListeners.indexOf(item);
      if (idx !== -1) this.wildcardListeners.splice(idx, 1);
    }

    await Promise.allSettled(promises);
  }

  /**
   * Remove a specific handler from an event.
   */
  off<K extends keyof Events & string>(
    event: K,
    handler: Handler<Events[K]>
  ): void {
    const bucket = this.listeners.get(event);
    if (!bucket) return;
    const idx = bucket.findIndex((e) => e.handler === (handler as Handler<unknown>));
    if (idx !== -1) bucket.splice(idx, 1);
    if (bucket.length === 0) this.listeners.delete(event);
  }

  /**
   * Remove all listeners for a specific event, or all listeners if no event given.
   */
  clear<K extends keyof Events & string>(event?: K): void {
    if (event !== undefined) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
      this.wildcardListeners = [];
    }
  }

  /**
   * Returns a copy of the event history buffer.
   * Optionally filter by event name.
   */
  getHistory<K extends keyof Events & string>(event?: K): HistoryEntry[] {
    if (event !== undefined) {
      return this.history.filter((e) => e.event === event);
    }
    return [...this.history];
  }

  /**
   * Clear the history buffer.
   */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * Returns the number of listeners for an event (or all if omitted).
   */
  listenerCount<K extends keyof Events & string>(event?: K): number {
    if (event !== undefined) {
      return (this.listeners.get(event) ?? []).length;
    }
    let total = this.wildcardListeners.length;
    for (const bucket of this.listeners.values()) {
      total += bucket.length;
    }
    return total;
  }

  private _addListener(
    event: string,
    handler: Handler<unknown>,
    once: boolean
  ): () => void {
    const entry: ListenerEntry<unknown> = { handler, once };
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(entry);
    return () => {
      const bucket = this.listeners.get(event);
      if (!bucket) return;
      const idx = bucket.indexOf(entry);
      if (idx !== -1) bucket.splice(idx, 1);
      if (bucket.length === 0) this.listeners.delete(event);
    };
  }
}
