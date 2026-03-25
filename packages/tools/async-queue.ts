/**
 * AsyncQueue<T> - async FIFO queue with blocking dequeue and backpressure.
 *
 * Features:
 * - Blocking dequeue: awaits until an item is available
 * - Capacity limit with backpressure: enqueue blocks when queue is full
 * - Drain: wait for queue to empty
 * - Peek: inspect front item without consuming
 * - Async iterator: for-await-of support
 * - Close: signal producers to stop; pending dequeues resolve with undefined
 */

export class AsyncQueue<T> {
  private items: T[] = [];
  private waitingDequeues: Array<(value: T | undefined) => void> = [];
  private waitingEnqueues: Array<() => void> = [];
  private waitingDrains: Array<() => void> = [];
  private closed = false;
  private readonly capacity: number;

  constructor(capacity = Infinity) {
    if (capacity <= 0) throw new RangeError("capacity must be > 0");
    this.capacity = capacity;
  }

  get size(): number {
    return this.items.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isFull(): boolean {
    return this.items.length >= this.capacity;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  /**
   * Enqueue an item. Blocks (backpressure) if queue is at capacity.
   * Throws if the queue is closed.
   */
  async enqueue(item: T): Promise<void> {
    if (this.closed) throw new Error("AsyncQueue is closed");

    // If a consumer is waiting, hand off directly
    if (this.waitingDequeues.length > 0) {
      const resolve = this.waitingDequeues.shift()!;
      resolve(item);
      return;
    }

    // Apply backpressure: block until space is available
    while (this.items.length >= this.capacity) {
      if (this.closed) throw new Error("AsyncQueue closed while waiting to enqueue");
      await new Promise<void>((resolve) => {
        this.waitingEnqueues.push(resolve);
      });
    }

    this.items.push(item);
  }

  /**
   * Dequeue the next item. Blocks until an item is available.
   * Returns undefined if the queue is closed and empty.
   */
  async dequeue(): Promise<T | undefined> {
    if (this.items.length > 0) {
      const item = this.items.shift()!;
      this._notifyEnqueue();
      this._notifyDrain();
      return item;
    }

    if (this.closed) return undefined;

    return new Promise<T | undefined>((resolve) => {
      this.waitingDequeues.push(resolve);
    });
  }

  /**
   * Peek at the front item without removing it.
   * Returns undefined if empty.
   */
  peek(): T | undefined {
    return this.items[0];
  }

  /**
   * Wait until the queue is empty.
   */
  drain(): Promise<void> {
    if (this.items.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waitingDrains.push(resolve);
    });
  }

  /**
   * Close the queue. Pending dequeues resolve with undefined.
   * Further enqueues throw.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Release all waiting dequeues
    for (const resolve of this.waitingDequeues) {
      resolve(undefined);
    }
    this.waitingDequeues = [];
    // Release all waiting enqueues (they will throw on retry)
    for (const resolve of this.waitingEnqueues) {
      resolve();
    }
    this.waitingEnqueues = [];
    // Notify drains
    this._notifyDrain();
  }

  private _notifyEnqueue(): void {
    const resolve = this.waitingEnqueues.shift();
    if (resolve) resolve();
  }

  private _notifyDrain(): void {
    if (this.items.length === 0) {
      for (const resolve of this.waitingDrains) {
        resolve();
      }
      this.waitingDrains = [];
    }
  }

  /**
   * Async iterator: dequeues items until the queue is closed and empty.
   */
  async *[Symbol.asyncIterator](): AsyncIterableIterator<T> {
    while (true) {
      const item = await this.dequeue();
      if (item === undefined) break;
      yield item;
    }
  }
}
