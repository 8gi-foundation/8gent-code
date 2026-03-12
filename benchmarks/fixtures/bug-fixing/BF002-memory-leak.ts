/**
 * Fixture: BF002 - Memory Leak Bug
 *
 * Bug: Event listeners are never cleaned up, causing memory leak
 * Task: Fix the memory leak by properly managing subscriptions
 */

type EventHandler = (data: unknown) => void;

class EventEmitter {
  private handlers: Map<string, Set<EventHandler>> = new Map();

  on(event: string, handler: EventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  emit(event: string, data: unknown): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      handlers.forEach((handler) => handler(data));
    }
  }

  // BUG: This method exists but is never used when components are destroyed
  off(event: string, handler: EventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }
}

const globalEmitter = new EventEmitter();

export class DataSubscriber {
  private id: string;
  private data: unknown[] = [];

  constructor(id: string) {
    this.id = id;

    // BUG: Event handler captures 'this' but is never removed
    globalEmitter.on("data", (data) => {
      this.data.push(data);
      console.log(`Subscriber ${this.id} received data`);
    });
  }

  getData(): unknown[] {
    return this.data;
  }

  // BUG: destroy() should clean up event listeners but doesn't
  destroy(): void {
    console.log(`Subscriber ${this.id} destroyed`);
    // Memory leak: handler is still registered!
  }
}

// Demonstration of the leak
export function demonstrateLeak(): void {
  const subscribers: DataSubscriber[] = [];

  // Create 1000 subscribers
  for (let i = 0; i < 1000; i++) {
    subscribers.push(new DataSubscriber(`sub-${i}`));
  }

  // "Destroy" them all
  subscribers.forEach((sub) => sub.destroy());
  subscribers.length = 0;

  // But handlers are still registered!
  globalEmitter.emit("data", { test: true });
  // All 1000 handlers still fire - memory leak!
}
