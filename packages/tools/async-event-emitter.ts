/**
 * AsyncEventEmitter - typed event emitter that awaits all async handlers.
 * Supports parallel and serial emission modes, on/once/off/emit API.
 */

export type AsyncHandler<T = unknown> = (data: T) => Promise<void> | void;

export type EmitMode = "parallel" | "serial";

interface HandlerEntry<T> {
  handler: AsyncHandler<T>;
  once: boolean;
}

export class AsyncEventEmitter<Events extends Record<string, unknown> = Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, HandlerEntry<unknown>[]>();
  private defaultMode: EmitMode;

  constructor(defaultMode: EmitMode = "parallel") {
    this.defaultMode = defaultMode;
  }

  on<K extends keyof Events>(event: K, handler: AsyncHandler<Events[K]>): this {
    this.addListener(event, handler, false);
    return this;
  }

  once<K extends keyof Events>(event: K, handler: AsyncHandler<Events[K]>): this {
    this.addListener(event, handler, true);
    return this;
  }

  off<K extends keyof Events>(event: K, handler: AsyncHandler<Events[K]>): this {
    const entries = this.listeners.get(event);
    if (!entries) return this;
    const filtered = entries.filter((e) => e.handler !== handler);
    if (filtered.length === 0) {
      this.listeners.delete(event);
    } else {
      this.listeners.set(event, filtered);
    }
    return this;
  }

  /** Emit using the instance default mode (parallel or serial). */
  async emit<K extends keyof Events>(event: K, data: Events[K]): Promise<void> {
    return this.defaultMode === "serial"
      ? this.emitSerial(event, data)
      : this.emitParallel(event, data);
  }

  /** Await all handlers concurrently. Errors propagate via Promise.all. */
  async emitParallel<K extends keyof Events>(event: K, data: Events[K]): Promise<void> {
    const entries = this.drainOnce(event);
    if (!entries.length) return;
    await Promise.all(entries.map((e) => Promise.resolve(e.handler(data))));
  }

  /** Await each handler in registration order before calling the next. */
  async emitSerial<K extends keyof Events>(event: K, data: Events[K]): Promise<void> {
    const entries = this.drainOnce(event);
    for (const entry of entries) {
      await Promise.resolve(entry.handler(data));
    }
  }

  /** Number of registered listeners for an event. */
  listenerCount<K extends keyof Events>(event: K): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  /** All event names that have at least one listener. */
  eventNames(): Array<keyof Events> {
    return Array.from(this.listeners.keys());
  }

  /** Remove all listeners for an event, or all events if omitted. */
  removeAllListeners<K extends keyof Events>(event?: K): this {
    if (event !== undefined) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
    return this;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private addListener<K extends keyof Events>(
    event: K,
    handler: AsyncHandler<Events[K]>,
    once: boolean
  ): void {
    const entries = this.listeners.get(event) ?? [];
    entries.push({ handler: handler as AsyncHandler<unknown>, once });
    this.listeners.set(event, entries);
  }

  /**
   * Returns current entries for the event, removing any once-listeners so
   * they fire exactly once even under concurrent emits.
   */
  private drainOnce<K extends keyof Events>(event: K): HandlerEntry<unknown>[] {
    const entries = this.listeners.get(event);
    if (!entries || entries.length === 0) return [];

    const persistent = entries.filter((e) => !e.once);
    if (persistent.length !== entries.length) {
      if (persistent.length === 0) {
        this.listeners.delete(event);
      } else {
        this.listeners.set(event, persistent);
      }
    }

    return entries;
  }
}
