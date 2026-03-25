/**
 * A type-safe EventEmitter replacement with event map types.
 * @template Events - A record of event names to their data types.
 */
export class TypedEventEmitter<Events extends Record<string, unknown>> {
  private _map = new Map<string, Function[]>();

  /**
   * Adds a listener for the specified event.
   * @param event The event name.
   * @param handler The handler function.
   * @returns This instance for method chaining.
   */
  on<Event extends keyof Events>(event: Event, handler: (data: Events[Event]) => void): this {
    if (!this._map.has(event)) this._map.set(event, []);
    this._map.get(event)!.push(handler);
    return this;
  }

  /**
   * Removes a listener for the specified event.
   * @param event The event name.
   * @param handler The handler function to remove.
   * @returns This instance for method chaining.
   */
  off<Event extends keyof Events>(event: Event, handler: (data: Events[Event]) => void): this {
    const handlers = this._map.get(event);
    if (!handlers) return this;
    const index = handlers.indexOf(handler);
    if (index !== -1) handlers.splice(index, 1);
    return this;
  }

  /**
   * Emits the specified event with data.
   * @param event The event name.
   * @param data The data to pass to listeners.
   * @returns True if any listeners were called, false otherwise.
   */
  emit<Event extends keyof Events>(event: Event, data: Events[Event]): boolean {
    const handlers = this._map.get(event);
    if (!handlers || handlers.length === 0) return false;
    handlers.forEach(handler => handler(data));
    return true;
  }

  /**
   * Adds a one-time listener for the specified event.
   * @param event The event name.
   * @returns A promise that resolves with the emitted data.
   */
  once<Event extends keyof Events>(event: Event): Promise<Events[Event]> {
    return new Promise<Events[Event]>((resolve) => {
      const handler = (data: Events[Event]) => {
        this.off(event, handler);
        resolve(data);
      };
      this.on(event, handler);
    });
  }

  /**
   * Returns the number of listeners for the specified event.
   * @param event The event name.
   * @returns The number of listeners.
   */
  listenerCount<Event extends keyof Events>(event: Event): number {
    const handlers = this._map.get(event);
    return handlers ? handlers.length : 0;
  }

  /**
   * Removes all listeners for the specified event or all events.
   * @param event The event name (optional).
   * @returns This instance for method chaining.
   */
  removeAllListeners<Event extends keyof Events>(event?: Event): this {
    if (event) {
      this._map.delete(event);
    } else {
      this._map.clear();
    }
    return this;
  }
}