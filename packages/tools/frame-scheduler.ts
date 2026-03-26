/**
 * Schedules work across animation frames using setInterval.
 */
export class FrameScheduler {
  #queue: Array<() => void> = [];
  #running: boolean = false;
  #intervalId: number | null = null;
  readonly targetFPS: number;
  #interval: number;

  /**
   * Creates a new FrameScheduler instance.
   * @param targetFPS - Target frames per second.
   */
  constructor(targetFPS: number) {
    this.targetFPS = Math.max(1, targetFPS);
    this.#interval = 1000 / this.targetFPS;
  }

  /**
   * Queues a function to be executed on the next frame.
   * @param fn - Function to execute.
   */
  schedule(fn: () => void): void {
    this.#queue.push(fn);
    if (!this.#running) {
      this.resume();
    }
  }

  /**
   * Checks if the scheduler is currently running.
   * @returns True if running, false otherwise.
   */
  isRunning(): boolean {
    return this.#running;
  }

  /**
   * Pauses the scheduler.
   */
  pause(): void {
    if (this.#intervalId !== null) {
      clearInterval(this.#intervalId);
      this.#intervalId = null;
      this.#running = false;
    }
  }

  /**
   * Resumes the scheduler.
   */
  resume(): void {
    if (this.#running || this.#intervalId !== null) {
      return;
    }
    this.#running = true;
    this.#intervalId = setInterval(this.#tick, this.#interval);
  }

  #tick(): void {
    while (this.#queue.length > 0) {
      const fn = this.#queue.shift();
      if (fn) fn();
    }
  }
}