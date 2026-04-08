/**
 * PromiseQueue v2 - Serial promise queue with priority ordering and concurrency limit.
 *
 * Features:
 * - Priority-ordered execution (higher number = runs first)
 * - Configurable concurrency limit (default: 1 = serial)
 * - Pause / resume support
 * - onEmpty drain event
 * - size, pending, isPaused introspection
 * - clear() to discard waiting tasks
 */

type Task<T> = {
  fn: () => Promise<T>;
  priority: number;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

export class PromiseQueue {
  private queue: Task<unknown>[] = [];
  private running = 0;
  private paused = false;
  private concurrency: number;
  private emptyListeners: Array<() => void> = [];

  constructor(concurrency = 1) {
    if (concurrency < 1) throw new RangeError("concurrency must be >= 1");
    this.concurrency = concurrency;
  }

  /** Number of tasks waiting to run (does not include running tasks). */
  get size(): number {
    return this.queue.length;
  }

  /** Number of tasks currently executing. */
  get pending(): number {
    return this.running;
  }

  /** Whether the queue is paused. */
  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Add a task to the queue.
   * @param fn   Async factory returning a Promise.
   * @param priority  Higher numbers run first. Ties preserve insertion order.
   * @returns Promise that resolves/rejects when the task completes.
   */
  add<T>(fn: () => Promise<T>, priority = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: Task<T> = { fn, priority, resolve, reject };
      this.enqueue(task as Task<unknown>);
      this.tick();
    });
  }

  /** Register a callback fired once when the queue drains to empty (size + pending === 0). */
  onEmpty(cb: () => void): () => void {
    this.emptyListeners.push(cb);
    return () => {
      this.emptyListeners = this.emptyListeners.filter((l) => l !== cb);
    };
  }

  /** Pause execution. In-flight tasks continue; new tasks queue up. */
  pause(): void {
    this.paused = true;
  }

  /** Resume execution and drain the queue. */
  start(): void {
    this.paused = false;
    this.tick();
  }

  /** Remove all waiting tasks, rejecting their promises. */
  clear(): void {
    const waiting = this.queue.splice(0);
    for (const task of waiting) {
      task.reject(new Error("PromiseQueue cleared"));
    }
  }

  // --- internals ---

  private enqueue(task: Task<unknown>): void {
    // Binary-insert by descending priority, preserving insertion order for ties.
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.queue[mid].priority >= task.priority) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, task);
  }

  private tick(): void {
    while (!this.paused && this.running < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.running++;
      task
        .fn()
        .then(task.resolve, task.reject)
        .finally(() => {
          this.running--;
          this.tick();
          if (this.running === 0 && this.queue.length === 0) {
            for (const cb of this.emptyListeners.slice()) cb();
          }
        });
    }
  }
}
