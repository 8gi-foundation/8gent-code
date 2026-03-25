/**
 * Async semaphore for controlling concurrent operation limits.
 * Queues waiting tasks when concurrency limit is reached.
 * Supports configurable timeouts and exposes usage statistics.
 */

export interface SemaphoreStats {
  /** Max concurrent operations allowed */
  maxConcurrency: number;
  /** Currently active (acquired) slots */
  active: number;
  /** Tasks waiting in queue */
  queued: number;
  /** Total successful acquires since creation */
  totalAcquired: number;
  /** Total releases since creation */
  totalReleased: number;
  /** Total acquire attempts that timed out */
  totalTimeouts: number;
}

export interface AcquireOptions {
  /** Timeout in ms. If exceeded, rejects with SemaphoreTimeoutError. */
  timeoutMs?: number;
  /** Optional label for debugging */
  label?: string;
}

export class SemaphoreTimeoutError extends Error {
  constructor(label?: string, timeoutMs?: number) {
    super(
      label
        ? `Semaphore acquire timed out for "${label}" after ${timeoutMs}ms`
        : `Semaphore acquire timed out after ${timeoutMs}ms`
    );
    this.name = "SemaphoreTimeoutError";
  }
}

interface QueueEntry {
  resolve: () => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  label?: string;
}

export class Semaphore {
  private readonly _max: number;
  private _active = 0;
  private readonly _queue: QueueEntry[] = [];
  private _totalAcquired = 0;
  private _totalReleased = 0;
  private _totalTimeouts = 0;

  constructor(maxConcurrency: number) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new RangeError("maxConcurrency must be a positive integer");
    }
    this._max = maxConcurrency;
  }

  /** Acquire a slot. Waits in queue if at capacity. */
  acquire(options: AcquireOptions = {}): Promise<void> {
    const { timeoutMs, label } = options;

    if (this._active < this._max) {
      this._active++;
      this._totalAcquired++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = { resolve, reject, label };

      if (timeoutMs !== undefined && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          const idx = this._queue.indexOf(entry);
          if (idx !== -1) {
            this._queue.splice(idx, 1);
            this._totalTimeouts++;
            reject(new SemaphoreTimeoutError(label, timeoutMs));
          }
        }, timeoutMs);
      }

      this._queue.push(entry);
    });
  }

  /** Release a previously acquired slot. */
  release(): void {
    if (this._active <= 0) {
      throw new Error("Semaphore release called more times than acquire");
    }

    if (this._queue.length > 0) {
      const next = this._queue.shift()!;
      if (next.timer !== undefined) {
        clearTimeout(next.timer);
      }
      this._totalAcquired++;
      this._totalReleased++;
      next.resolve();
    } else {
      this._active--;
      this._totalReleased++;
    }
  }

  /**
   * Run a task with automatic acquire/release.
   * Preferred over manual acquire/release.
   */
  async run<T>(fn: () => Promise<T>, options: AcquireOptions = {}): Promise<T> {
    await this.acquire(options);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Current usage statistics. */
  get stats(): SemaphoreStats {
    return {
      maxConcurrency: this._max,
      active: this._active,
      queued: this._queue.length,
      totalAcquired: this._totalAcquired,
      totalReleased: this._totalReleased,
      totalTimeouts: this._totalTimeouts,
    };
  }

  /** True if a slot is immediately available. */
  get available(): boolean {
    return this._active < this._max;
  }
}
