/**
 * A utility to execute low-priority tasks during idle time.
 */
export class IdleQueue {
  private queue: Array<{ fn: () => void; priority: number }> = [];
  private autoDrain: boolean = false;

  /**
   * Add a task to the queue.
   * @param fn - The function to execute.
   * @param priority - Optional priority (lower numbers execute first).
   */
  add(fn: () => void, priority: number = 0): void {
    this.queue.push({ fn, priority });
    this.queue.sort((a, b) => a.priority - b.priority);
    if (this.autoDrain) {
      this.flush();
    }
  }

  /**
   * Execute all queued tasks immediately.
   */
  flush(): void {
    const tasks = [...this.queue];
    this.queue.length = 0;
    tasks.forEach(task => task.fn());
  }

  /**
   * Enable auto-drain mode (tasks are flushed immediately upon addition).
   */
  start(): void {
    this.autoDrain = true;
  }

  /**
   * Disable auto-drain mode.
   */
  stop(): void {
    this.autoDrain = false;
  }
}