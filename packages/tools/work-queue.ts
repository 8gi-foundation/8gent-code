/**
 * Priority work queue with concurrency control.
 */
class WorkQueue {
  private queues: { fn: () => Promise<void>; resolve: () => void; reject: (e: any) => void }[][] = Array(10).fill(null).map(() => []);
  private maxConcurrency: number;
  private paused: boolean = false;
  private running: number = 0;
  private pending: number = 0;
  private completed: number = 0;

  /**
   * Create a new WorkQueue instance.
   * @param maxConcurrency Maximum number of concurrent tasks.
   */
  constructor(maxConcurrency: number = 1) {
    this.maxConcurrency = maxConcurrency;
  }

  /**
   * Add a task to the queue.
   * @param fn Task function.
   * @param priority Task priority (0-9, higher first).
   * @returns Promise that resolves when task completes.
   */
  add(fn: () => Promise<void>, priority: number = 0): Promise<void> {
    const index = Math.max(0, Math.min(9, priority));
    const queue = this.queues[9 - index];
    const promise = new Promise<void>((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      this.pending++;
      if (!this.paused && this.running < this.maxConcurrency) {
        this.processNextTask();
      }
    });
    return promise;
  }

  /**
   * Pause new task starts.
   */
  pause(): void {
    this.paused = true;
  }

  /**
   * Resume task starts.
   */
  resume(): void {
    this.paused = false;
    this.processNextTask();
  }

  /**
   * Get queue statistics.
   * @returns { pending: number, running: number, completed: number }
   */
  getStats(): { pending: number; running: number; completed: number } {
    return { pending: this.pending, running: this.running, completed: this.completed };
  }

  private async processNextTask(): Promise<void> {
    if (this.paused || this.running >= this.maxConcurrency) {
      return;
    }

    for (let i = 0; i < 10; i++) {
      const queue = this.queues[i];
      if (queue.length > 0) {
        const task = queue.shift()!;
        this.running++;
        this.pending--;
        try {
          await task.fn();
          task.resolve();
        } catch (e) {
          task.reject(e);
        } finally {
          this.completed++;
          this.running--;
          await this.processNextTask();
        }
        return;
      }
    }
  }
}

export { WorkQueue };