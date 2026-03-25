/**
 * A typed event bus for publish-subscribe pattern.
 * @template EventMap
 */
export class EventBus<EventMap> {
  private handlers = new Map<keyof EventMap, Array<Function>>();

  /**
   * Subscribe to an event.
   * @param event The event name.
   * @param handler The handler function.
   */
  on<E extends keyof EventMap>(event: E, handler: (data: EventMap[E]) => void): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event)!.push(handler);
  }

  /**
   * Unsubscribe from an event.
   * @param event The event name.
   * @param handler The handler function.
   */
  off<E extends keyof EventMap>(event: E, handler: (data: EventMap[E]) => void): void {
    const handlers = this.handlers.get(event);
    if (!handlers) return;
    const index = handlers.indexOf(handler);
    if (index !== -1) {
      handlers.splice(index, 1);
    }
    if (handlers.length === 0) {
      this.handlers.delete(event);
    }
  }

  /**
   * Subscribe to an event once.
   * @param event The event name.
   * @param handler The handler function.
   */
  once<E extends keyof EventMap>(event: E, handler: (data: EventMap[E]) => void): void {
    const wrappedHandler = (...args: any[]) => {
      handler(...args);
      this.off(event, wrappedHandler);
    };
    this.on(event, wrappedHandler);
  }

  /**
   * Emit an event synchronously.
   * @param event The event name.
   * @param data The data to pass to handlers.
   */
  emit<E extends keyof EventMap>(event: E, data: EventMap[E]): void {
    const handlers = this.handlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      handler(data);
    }
  }

  /**
   * Emit an event asynchronously, sequentially.
   * @param event The event name.
   * @param data The data to pass to handlers.
   * @returns A promise that resolves when all handlers are done.
   */
  async emitAsync<E extends keyof EventMap>(event: E, data: EventMap[E]): Promise<void> {
    const handlers = this.handlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      await handler(data);
    }
  }
}

export { EventBus };