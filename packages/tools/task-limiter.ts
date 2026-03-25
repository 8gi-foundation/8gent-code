/**
 * 8gent Code - Task Limiter
 *
 * Limits concurrent async task execution with automatic queuing,
 * pause/resume support, and drain events. No external dependencies.
 */

type Task<T> = () => Promise<T>;

interface QueueEntry<T> {
  task: Task<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class TaskLimiter {
  private readonly maxConcurrent: number;
  private _activeCount = 0;
  private _paused = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queue: QueueEntry<any>[] = [];
  private drainListeners: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    if (maxConcurrent < 1) throw new Error("maxConcurrent must be >= 1");
    this.maxConcurrent = maxConcurrent;
  }

  /** Number of tasks currently running */
  get activeCount(): number {
    return this._activeCount;
  }

  /** Number of tasks waiting in the queue */
  get pendingCount(): number {
    return this.queue.length;
  }

  /**
   * Run a task, or enqueue it if at capacity or paused.
   * Returns a promise that resolves/rejects with the task result.
   */
  run<T>(task: Task<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this._paused && this._activeCount < this.maxConcurrent) {
        this.execute(task, resolve, reject);
      } else {
        this.queue.push({ task, resolve, reject });
      }
    });
  }

  /**
   * Register a callback to fire when all tasks finish and the queue empties.
   * The callback is removed automatically after firing once.
   */
  onDrain(callback: () => void): void {
    this.drainListeners.push(callback);
    // If already idle, fire immediately
    if (this._activeCount === 0 && this.queue.length === 0) {
      this.fireDrain();
    }
  }

  /**
   * Pause processing new tasks from the queue.
   * Tasks already running continue to completion.
   */
  pause(): void {
    this._paused = true;
  }

  /**
   * Resume processing queued tasks.
   */
  resume(): void {
    if (!this._paused) return;
    this._paused = false;
    this.drain();
  }

  /**
   * Reject all pending (queued, not yet started) tasks.
   * Does not cancel tasks already running.
   */
  clearQueue(reason: unknown = new Error("Queue cleared")): void {
    const pending = this.queue.splice(0);
    for (const entry of pending) {
      entry.reject(reason);
    }
  }

  // --- private helpers ---

  private execute<T>(
    task: Task<T>,
    resolve: (value: T) => void,
    reject: (reason: unknown) => void
  ): void {
    this._activeCount++;
    task().then(
      (result) => {
        resolve(result);
        this.onTaskDone();
      },
      (err) => {
        reject(err);
        this.onTaskDone();
      }
    );
  }

  private onTaskDone(): void {
    this._activeCount--;
    this.drain();
    if (this._activeCount === 0 && this.queue.length === 0) {
      this.fireDrain();
    }
  }

  private drain(): void {
    while (
      !this._paused &&
      this._activeCount < this.maxConcurrent &&
      this.queue.length > 0
    ) {
      const entry = this.queue.shift()!;
      this.execute(entry.task, entry.resolve, entry.reject);
    }
  }

  private fireDrain(): void {
    const listeners = this.drainListeners.splice(0);
    for (const cb of listeners) cb();
  }
}
