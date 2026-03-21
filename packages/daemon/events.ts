/**
 * EventBus - Typed pub/sub event system for the daemon.
 *
 * Events flow from agent internals to WebSocket clients, log writers,
 * and internal handlers via a single bus.
 */

export interface DaemonEvents {
  "tool:start": { sessionId: string; tool: string; input: unknown };
  "tool:result": { sessionId: string; tool: string; output: unknown; durationMs: number };
  "agent:thinking": { sessionId: string };
  "agent:stream": { sessionId: string; chunk: string };
  "agent:error": { sessionId: string; error: string };
  "memory:saved": { sessionId: string; key: string };
  "approval:required": { sessionId: string; tool: string; input: unknown; requestId: string };
  "session:start": { sessionId: string; channel: string };
  "session:end": { sessionId: string; reason: string };
}

export type EventName = keyof DaemonEvents;
export type EventPayload<E extends EventName> = DaemonEvents[E];
export type EventHandler<E extends EventName> = (payload: EventPayload<E>) => void;

interface Subscription {
  event: EventName;
  handler: EventHandler<any>;
  id: number;
}

let nextId = 0;

export class EventBus {
  private subs: Map<EventName, Subscription[]> = new Map();

  on<E extends EventName>(event: E, handler: EventHandler<E>): number {
    const id = nextId++;
    const sub: Subscription = { event, handler, id };
    const list = this.subs.get(event) || [];
    list.push(sub);
    this.subs.set(event, list);
    return id;
  }

  off(id: number): void {
    for (const [event, list] of this.subs) {
      const idx = list.findIndex((s) => s.id === id);
      if (idx !== -1) {
        list.splice(idx, 1);
        if (list.length === 0) this.subs.delete(event);
        return;
      }
    }
  }

  emit<E extends EventName>(event: E, payload: EventPayload<E>): void {
    const list = this.subs.get(event);
    if (!list) return;
    for (const sub of list) {
      try {
        sub.handler(payload);
      } catch (err) {
        console.error(`[EventBus] handler error on ${event}:`, err);
      }
    }
  }

  /** Remove all subscriptions */
  clear(): void {
    this.subs.clear();
  }

  /** Get count of active subscriptions */
  get size(): number {
    let count = 0;
    for (const list of this.subs.values()) count += list.length;
    return count;
  }
}

/** Singleton bus for the daemon process */
export const bus = new EventBus();
