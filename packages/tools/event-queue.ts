/**
 * EventQueue - ordered event queue with priority, delayed delivery,
 * deduplication window, max size, and dead letter on failure.
 */

export interface QueueEvent<T = unknown> {
  id: string;
  payload: T;
  priority: number; // higher = processed first
  deliverAt: number; // epoch ms
  enqueuedAt: number;
  attempts: number;
}

export interface EnqueueOptions {
  priority?: number; // default 0
  delayMs?: number; // default 0 (immediate)
  dedupKey?: string; // dedup window key
  dedupWindowMs?: number; // default 5000ms
}

export interface DeadLetterEntry<T = unknown> {
  event: QueueEvent<T>;
  error: string;
  failedAt: number;
}

export interface EventQueueOptions {
  maxSize?: number; // default 1000
  maxRetries?: number; // default 3
  dedupWindowMs?: number; // default 5000
}

export class EventQueue<T = unknown> {
  private queue: QueueEvent<T>[] = [];
  private deadLetters: DeadLetterEntry<T>[] = [];
  private dedupRegistry = new Map<string, number>(); // key -> expiry epoch ms
  private maxSize: number;
  private maxRetries: number;
  private defaultDedupWindowMs: number;

  constructor(opts: EventQueueOptions = {}) {
    this.maxSize = opts.maxSize ?? 1000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.defaultDedupWindowMs = opts.dedupWindowMs ?? 5000;
  }

  enqueue(payload: T, options: EnqueueOptions = {}): string | null {
    const {
      priority = 0,
      delayMs = 0,
      dedupKey,
      dedupWindowMs = this.defaultDedupWindowMs,
    } = options;

    // deduplication check
    if (dedupKey) {
      const expiry = this.dedupRegistry.get(dedupKey);
      if (expiry && Date.now() < expiry) {
        return null; // duplicate within window - silently drop
      }
      this.dedupRegistry.set(dedupKey, Date.now() + dedupWindowMs);
    }

    if (this.queue.length >= this.maxSize) {
      throw new Error(`EventQueue full (maxSize=${this.maxSize})`);
    }

    const id = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const event: QueueEvent<T> = {
      id,
      payload,
      priority,
      deliverAt: Date.now() + delayMs,
      enqueuedAt: Date.now(),
      attempts: 0,
    };

    this.queue.push(event);
    this.sort();
    return id;
  }

  private sort(): void {
    // higher priority first; ties broken by deliverAt (earlier first)
    this.queue.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.deliverAt - b.deliverAt;
    });
  }

  private pruneDedupRegistry(): void {
    const now = Date.now();
    for (const [key, expiry] of this.dedupRegistry) {
      if (now >= expiry) this.dedupRegistry.delete(key);
    }
  }

  async process(handler: (payload: T) => Promise<void>): Promise<number> {
    this.pruneDedupRegistry();
    const now = Date.now();
    const ready = this.queue.filter((e) => e.deliverAt <= now);
    let processed = 0;

    for (const event of ready) {
      event.attempts++;
      try {
        await handler(event.payload);
        this.queue = this.queue.filter((e) => e.id !== event.id);
        processed++;
      } catch (err) {
        if (event.attempts >= this.maxRetries) {
          // move to dead letter queue
          this.deadLetters.push({
            event,
            error: err instanceof Error ? err.message : String(err),
            failedAt: Date.now(),
          });
          this.queue = this.queue.filter((e) => e.id !== event.id);
        }
        // else leave in queue for next process() call
      }
    }

    return processed;
  }

  pending(): number {
    return this.queue.length;
  }

  ready(atTime = Date.now()): number {
    return this.queue.filter((e) => e.deliverAt <= atTime).length;
  }

  deadLetterQueue(): DeadLetterEntry<T>[] {
    return [...this.deadLetters];
  }

  clearDeadLetters(): void {
    this.deadLetters = [];
  }

  drain(): QueueEvent<T>[] {
    const all = [...this.queue];
    this.queue = [];
    return all;
  }
}
