/**
 * EventDispatcher - typed event dispatcher with priority-ordered listeners.
 * Supports on/off/once/emit with numeric priority, listener introspection,
 * and once-semantics. Higher priority value fires first.
 */

export type Listener<T = unknown> = (data: T) => void;

interface ListenerEntry<T> {
  fn: Listener<T>;
  priority: number;
  once: boolean;
}

/**
 * EventMap is a record mapping event name -> payload type.
 * Example: `EventDispatcher<{ "user:login": { userId: string } }>`
 */
export class EventDispatcher<EventMap extends Record<string, unknown> = Record<string, unknown>> {
  private readonly _listeners = new Map<keyof EventMap, ListenerEntry<unknown>[]>();

  /**
   * Register a listener for an event.
   * Listeners with higher priority fire before those with lower priority.
   * Default priority is 0.
   */
  on<K extends keyof EventMap>(event: K, fn: Listener<EventMap[K]>, priority = 0): this {
    this._addEntry(event, fn, priority, false);
    return this;
  }

  /**
   * Register a one-time listener. Fires once then auto-removes.
   */
  once<K extends keyof EventMap>(event: K, fn: Listener<EventMap[K]>, priority = 0): this {
    this._addEntry(event, fn, priority, true);
    return this;
  }

  /**
   * Remove a previously registered listener (on or once).
   */
  off<K extends keyof EventMap>(event: K, fn: Listener<EventMap[K]>): this {
    const entries = this._listeners.get(event);
    if (!entries) return this;
    const filtered = entries.filter((e) => e.fn !== fn);
    if (filtered.length === 0) {
      this._listeners.delete(event);
    } else {
      this._listeners.set(event, filtered);
    }
    return this;
  }

  /**
   * Emit an event synchronously. Listeners are called in descending priority order.
   * Once-listeners are removed before invocation to prevent double-fire under
   * re-entrant emits.
   */
  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    const entries = this._listeners.get(event);
    if (!entries || entries.length === 0) return;

    // Snapshot to handle mutations during emit
    const snapshot = [...entries];

    // Strip once-entries before calling any handler (re-entrant safety)
    const persistent = entries.filter((e) => !e.once);
    if (persistent.length !== entries.length) {
      if (persistent.length === 0) {
        this._listeners.delete(event);
      } else {
        this._listeners.set(event, persistent);
      }
    }

    for (const entry of snapshot) {
      entry.fn(data as unknown);
    }
  }

  /**
   * Return a copy of all listener functions registered for an event,
   * in the order they would fire (descending priority).
   */
  listeners<K extends keyof EventMap>(event: K): Array<Listener<EventMap[K]>> {
    return (this._listeners.get(event) ?? []).map(
      (e) => e.fn as Listener<EventMap[K]>
    );
  }

  /**
   * Number of listeners currently registered for an event.
   */
  listenerCount<K extends keyof EventMap>(event: K): number {
    return this._listeners.get(event)?.length ?? 0;
  }

  /**
   * Remove all listeners for a specific event, or all events if omitted.
   */
  removeAllListeners<K extends keyof EventMap>(event?: K): this {
    if (event !== undefined) {
      this._listeners.delete(event);
    } else {
      this._listeners.clear();
    }
    return this;
  }

  /**
   * All event names that currently have at least one listener.
   */
  eventNames(): Array<keyof EventMap> {
    return Array.from(this._listeners.keys());
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private _addEntry<K extends keyof EventMap>(
    event: K,
    fn: Listener<EventMap[K]>,
    priority: number,
    once: boolean
  ): void {
    const entries = this._listeners.get(event) ?? [];
    entries.push({ fn: fn as Listener<unknown>, priority, once });
    // Sort descending by priority so highest fires first
    entries.sort((a, b) => b.priority - a.priority);
    this._listeners.set(event, entries);
  }
}
