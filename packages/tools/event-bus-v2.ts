/**
 * EventBus v2 - namespaced, typed, persistent event bus
 * Supports: on/off/once/emit, namespaces, event history replay, wildcard matching
 */

type EventPayload = Record<string, unknown> | unknown;

interface EventRecord<T = EventPayload> {
  event: string;
  payload: T;
  timestamp: number;
  namespace: string;
}

type Listener<T = EventPayload> = (payload: T, record: EventRecord<T>) => void;

interface ListenerEntry<T = EventPayload> {
  listener: Listener<T>;
  once: boolean;
}

/** Matches event name against a pattern (supports * wildcard) */
function matchesPattern(pattern: string, event: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === event;
  const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
  return regex.test(event);
}

export class NamespacedBus {
  private namespace: string;
  private root: EventBus;

  constructor(namespace: string, root: EventBus) {
    this.namespace = namespace;
    this.root = root;
  }

  on<T = EventPayload>(event: string, listener: Listener<T>): this {
    this.root.on(`${this.namespace}:${event}`, listener as Listener);
    return this;
  }

  off<T = EventPayload>(event: string, listener: Listener<T>): this {
    this.root.off(`${this.namespace}:${event}`, listener as Listener);
    return this;
  }

  once<T = EventPayload>(event: string, listener: Listener<T>): this {
    this.root.once(`${this.namespace}:${event}`, listener as Listener);
    return this;
  }

  emit<T = EventPayload>(event: string, payload?: T): this {
    this.root.emit(`${this.namespace}:${event}`, payload);
    return this;
  }

  /** Replay historical events for this namespace */
  replay(event?: string): void {
    const pattern = event ? `${this.namespace}:${event}` : `${this.namespace}:*`;
    this.root.replay(pattern);
  }
}

export class EventBus {
  private listeners = new Map<string, ListenerEntry[]>();
  private history: EventRecord[] = [];
  private maxHistory: number;

  constructor(options: { maxHistory?: number } = {}) {
    this.maxHistory = options.maxHistory ?? 500;
  }

  /** Subscribe to an event or wildcard pattern */
  on<T = EventPayload>(event: string, listener: Listener<T>): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push({ listener: listener as Listener, once: false });
    return this;
  }

  /** Unsubscribe a listener */
  off<T = EventPayload>(event: string, listener: Listener<T>): this {
    const entries = this.listeners.get(event);
    if (!entries) return this;
    const filtered = entries.filter((e) => e.listener !== listener);
    if (filtered.length === 0) {
      this.listeners.delete(event);
    } else {
      this.listeners.set(event, filtered);
    }
    return this;
  }

  /** Subscribe once - auto-removed after first call */
  once<T = EventPayload>(event: string, listener: Listener<T>): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push({ listener: listener as Listener, once: true });
    return this;
  }

  /** Emit an event to all matching listeners */
  emit<T = EventPayload>(event: string, payload?: T): this {
    const record: EventRecord<T> = {
      event,
      payload: payload as T,
      timestamp: Date.now(),
      namespace: event.includes(":") ? event.split(":")[0] : "root",
    };

    // Persist to history
    this.history.push(record as EventRecord);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    // Dispatch to all matching registered patterns
    for (const [pattern, entries] of this.listeners) {
      if (matchesPattern(pattern, event)) {
        const toRemove: ListenerEntry[] = [];
        for (const entry of entries) {
          entry.listener(payload, record as EventRecord);
          if (entry.once) toRemove.push(entry);
        }
        if (toRemove.length > 0) {
          const remaining = entries.filter((e) => !toRemove.includes(e));
          if (remaining.length === 0) {
            this.listeners.delete(pattern);
          } else {
            this.listeners.set(pattern, remaining);
          }
        }
      }
    }

    return this;
  }

  /** Replay all history matching an event pattern to current listeners */
  replay(pattern: string = "*"): void {
    const matching = this.history.filter((r) => matchesPattern(pattern, r.event));
    for (const record of matching) {
      for (const [listenerPattern, entries] of this.listeners) {
        if (matchesPattern(listenerPattern, record.event)) {
          for (const entry of entries) {
            entry.listener(record.payload, record);
          }
        }
      }
    }
  }

  /** Get event history, optionally filtered by pattern */
  getHistory(pattern: string = "*"): EventRecord[] {
    return this.history.filter((r) => matchesPattern(pattern, r.event));
  }

  /** Clear event history */
  clearHistory(): void {
    this.history = [];
  }

  /** Remove all listeners for an event (or all events) */
  removeAllListeners(event?: string): this {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
    return this;
  }

  /** Get a namespaced sub-bus */
  namespace(ns: string): NamespacedBus {
    return new NamespacedBus(ns, this);
  }
}

export const bus = new EventBus();
