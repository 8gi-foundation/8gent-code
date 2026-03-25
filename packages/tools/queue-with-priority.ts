/**
 * PriorityAsyncQueue - async queue with priority lanes and fair scheduling.
 *
 * Three priority lanes: high, normal, low.
 * Fairness ratio prevents low-priority starvation by guaranteeing
 * at minimum 1-in-N dequeues go to the next lower lane.
 */

export type Priority = "high" | "normal" | "low";

export interface QueueItem<T> {
  item: T;
  priority: Priority;
  enqueueTime: number;
}

export interface PriorityQueueOptions {
  /** Max size per lane. 0 = unlimited. Default: 0 */
  maxPerLane?: number;
  /**
   * Fairness ratio: after this many high-priority dequeues without
   * serving normal, force a normal dequeue (if available).
   * Same ratio applied between normal and low.
   * Default: 5
   */
  fairnessRatio?: number;
}

const PRIORITY_ORDER: Priority[] = ["high", "normal", "low"];

export class PriorityAsyncQueue<T> {
  private lanes: Record<Priority, QueueItem<T>[]> = {
    high: [],
    normal: [],
    low: [],
  };

  private maxPerLane: number;
  private fairnessRatio: number;

  // Tracks consecutive dequeues from a higher lane without serving lower lanes
  private consecutiveCounts: Record<Priority, number> = {
    high: 0,
    normal: 0,
    low: 0,
  };

  // Waiters blocked on dequeue when all lanes are empty
  private waiters: Array<(item: QueueItem<T> | undefined) => void> = [];

  private _closed = false;

  constructor(options: PriorityQueueOptions = {}) {
    this.maxPerLane = options.maxPerLane ?? 0;
    this.fairnessRatio = options.fairnessRatio ?? 5;
  }

  get size(): number {
    return this.lanes.high.length + this.lanes.normal.length + this.lanes.low.length;
  }

  get closed(): boolean {
    return this._closed;
  }

  /** Add an item to the queue. Throws if queue is closed or lane is full. */
  enqueue(item: T, priority: Priority = "normal"): void {
    if (this._closed) throw new Error("Queue is closed");
    const lane = this.lanes[priority];
    if (this.maxPerLane > 0 && lane.length >= this.maxPerLane) {
      throw new Error(`Lane "${priority}" is full (max ${this.maxPerLane})`);
    }
    const entry: QueueItem<T> = { item, priority, enqueueTime: Date.now() };
    lane.push(entry);

    // Wake a waiter if any are blocked
    if (this.waiters.length > 0) {
      const resolve = this.waiters.shift()!;
      resolve(this._pickNext()!);
    }
  }

  /**
   * Dequeue the next item respecting priority and fairness.
   * Resolves when an item is available. Returns undefined if queue is closed
   * and empty.
   */
  async dequeue(): Promise<QueueItem<T> | undefined> {
    const next = this._pickNext();
    if (next !== undefined) return next;
    if (this._closed) return undefined;

    return new Promise<QueueItem<T> | undefined>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Close the queue. Pending waiters receive undefined. */
  close(): void {
    this._closed = true;
    for (const resolve of this.waiters) resolve(undefined);
    this.waiters = [];
  }

  /**
   * Drain all items in priority order. Returns them as an array.
   * Does not close the queue.
   */
  drain(): QueueItem<T>[] {
    const result: QueueItem<T>[] = [];
    // Reset fairness counters for a clean drain
    this.consecutiveCounts = { high: 0, normal: 0, low: 0 };
    for (const priority of PRIORITY_ORDER) {
      result.push(...this.lanes[priority].splice(0));
    }
    return result;
  }

  private _pickNext(): QueueItem<T> | undefined {
    for (let i = 0; i < PRIORITY_ORDER.length; i++) {
      const priority = PRIORITY_ORDER[i];
      const lane = this.lanes[priority];
      if (lane.length === 0) continue;

      // Check fairness: if we've served this lane too many times in a row,
      // try to yield to the next lane first (if it has items).
      const nextPriority = PRIORITY_ORDER[i + 1];
      if (
        nextPriority &&
        this.consecutiveCounts[priority] >= this.fairnessRatio &&
        this.lanes[nextPriority].length > 0
      ) {
        // Force a dequeue from the next lane
        this.consecutiveCounts[priority] = 0;
        return this._dequeueFrom(nextPriority);
      }

      return this._dequeueFrom(priority);
    }
    return undefined;
  }

  private _dequeueFrom(priority: Priority): QueueItem<T> {
    const item = this.lanes[priority].shift()!;
    // Increment consecutive count for this lane's parent (higher-priority lane)
    const idx = PRIORITY_ORDER.indexOf(priority);
    if (idx > 0) {
      const parent = PRIORITY_ORDER[idx - 1];
      this.consecutiveCounts[parent]++;
    }
    // Reset consecutive count for this lane
    this.consecutiveCounts[priority] = 0;
    return item;
  }
}
