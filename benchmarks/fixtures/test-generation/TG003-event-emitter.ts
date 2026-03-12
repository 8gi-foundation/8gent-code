/**
 * Fixture: TG003 - Generate Tests for Event Emitter
 *
 * Task: Generate comprehensive test suite for this event emitter
 * Requirements:
 * - Unit tests for all methods
 * - Async event handling tests
 * - Memory leak tests (subscription cleanup)
 * - Concurrency tests
 * - Error propagation tests
 */

export type EventHandler<T = unknown> = (data: T) => void | Promise<void>;
export type WildcardHandler = (event: string, data: unknown) => void | Promise<void>;

export interface EventSubscription {
  unsubscribe: () => void;
}

export interface EmitterStats {
  totalEvents: number;
  totalHandlers: number;
  eventCounts: Map<string, number>;
}

export class TypedEventEmitter<Events extends Record<string, unknown>> {
  private handlers: Map<keyof Events, Set<EventHandler<unknown>>> = new Map();
  private onceHandlers: Map<keyof Events, Set<EventHandler<unknown>>> = new Map();
  private wildcardHandlers: Set<WildcardHandler> = new Set();
  private maxListeners: number = 10;
  private stats: EmitterStats = {
    totalEvents: 0,
    totalHandlers: 0,
    eventCounts: new Map(),
  };

  /**
   * Subscribe to an event
   */
  on<K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): EventSubscription {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }

    const handlers = this.handlers.get(event)!;

    if (handlers.size >= this.maxListeners) {
      console.warn(`Warning: Event '${String(event)}' has ${handlers.size} listeners. ` + "This might indicate a memory leak.");
    }

    handlers.add(handler as EventHandler<unknown>);
    this.stats.totalHandlers++;

    return {
      unsubscribe: () => this.off(event, handler),
    };
  }

  /**
   * Subscribe to an event once
   */
  once<K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): EventSubscription {
    if (!this.onceHandlers.has(event)) {
      this.onceHandlers.set(event, new Set());
    }

    this.onceHandlers.get(event)!.add(handler as EventHandler<unknown>);
    this.stats.totalHandlers++;

    return {
      unsubscribe: () => {
        this.onceHandlers.get(event)?.delete(handler as EventHandler<unknown>);
      },
    };
  }

  /**
   * Subscribe to all events
   */
  onAny(handler: WildcardHandler): EventSubscription {
    this.wildcardHandlers.add(handler);
    this.stats.totalHandlers++;

    return {
      unsubscribe: () => this.wildcardHandlers.delete(handler),
    };
  }

  /**
   * Unsubscribe from an event
   */
  off<K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): boolean {
    const handlers = this.handlers.get(event);
    if (handlers?.delete(handler as EventHandler<unknown>)) {
      this.stats.totalHandlers--;
      return true;
    }
    return false;
  }

  /**
   * Emit an event
   */
  async emit<K extends keyof Events>(event: K, data: Events[K]): Promise<void> {
    this.stats.totalEvents++;
    this.stats.eventCounts.set(String(event), (this.stats.eventCounts.get(String(event)) || 0) + 1);

    const errors: Error[] = [];

    // Call regular handlers
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          await handler(data);
        } catch (err) {
          errors.push(err as Error);
        }
      }
    }

    // Call once handlers
    const onceHandlers = this.onceHandlers.get(event);
    if (onceHandlers) {
      for (const handler of onceHandlers) {
        try {
          await handler(data);
        } catch (err) {
          errors.push(err as Error);
        }
      }
      this.stats.totalHandlers -= onceHandlers.size;
      this.onceHandlers.delete(event);
    }

    // Call wildcard handlers
    for (const handler of this.wildcardHandlers) {
      try {
        await handler(String(event), data);
      } catch (err) {
        errors.push(err as Error);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, `${errors.length} handler(s) threw errors`);
    }
  }

  /**
   * Emit event synchronously
   */
  emitSync<K extends keyof Events>(event: K, data: Events[K]): void {
    this.stats.totalEvents++;

    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        handler(data);
      }
    }

    const onceHandlers = this.onceHandlers.get(event);
    if (onceHandlers) {
      for (const handler of onceHandlers) {
        handler(data);
      }
      this.onceHandlers.delete(event);
    }

    for (const handler of this.wildcardHandlers) {
      handler(String(event), data);
    }
  }

  /**
   * Wait for an event
   */
  waitFor<K extends keyof Events>(event: K, timeout?: number): Promise<Events[K]> {
    return new Promise((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const subscription = this.once(event, (data) => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve(data);
      });

      if (timeout) {
        timeoutId = setTimeout(() => {
          subscription.unsubscribe();
          reject(new Error(`Timeout waiting for event '${String(event)}'`));
        }, timeout);
      }
    });
  }

  /**
   * Remove all listeners for an event
   */
  removeAllListeners<K extends keyof Events>(event?: K): void {
    if (event) {
      const count = (this.handlers.get(event)?.size || 0) + (this.onceHandlers.get(event)?.size || 0);
      this.handlers.delete(event);
      this.onceHandlers.delete(event);
      this.stats.totalHandlers -= count;
    } else {
      this.handlers.clear();
      this.onceHandlers.clear();
      this.wildcardHandlers.clear();
      this.stats.totalHandlers = 0;
    }
  }

  /**
   * Get listener count for an event
   */
  listenerCount<K extends keyof Events>(event: K): number {
    return (this.handlers.get(event)?.size || 0) + (this.onceHandlers.get(event)?.size || 0);
  }

  /**
   * Set max listeners warning threshold
   */
  setMaxListeners(n: number): void {
    this.maxListeners = n;
  }

  /**
   * Get emitter statistics
   */
  getStats(): EmitterStats {
    return {
      ...this.stats,
      eventCounts: new Map(this.stats.eventCounts),
    };
  }

  /**
   * Get all event names with listeners
   */
  eventNames(): (keyof Events)[] {
    const events = new Set<keyof Events>();
    for (const event of this.handlers.keys()) {
      events.add(event);
    }
    for (const event of this.onceHandlers.keys()) {
      events.add(event);
    }
    return Array.from(events);
  }
}
