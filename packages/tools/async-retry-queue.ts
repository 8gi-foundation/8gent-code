/**
 * AsyncRetryQueue - queue that automatically retries failed async operations
 * with configurable backoff, pause/resume, and drain support.
 */

export interface RetryQueueOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  onSuccess?: <T>(result: T, attempt: number) => void;
  onFailure?: (error: unknown, attempts: number) => void;
}

interface QueueItem<T> {
  fn: () => Promise<T>;
  retries: number;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export class AsyncRetryQueue {
  private queue: QueueItem<unknown>[] = [];
  private running = false;
  private paused = false;

  private maxRetries: number;
  private initialDelay: number;
  private maxDelay: number;
  private backoffMultiplier: number;
  private onSuccess: RetryQueueOptions["onSuccess"];
  private onFailure: RetryQueueOptions["onFailure"];

  constructor(opts: RetryQueueOptions = {}) {
    this.maxRetries = opts.maxRetries ?? 3;
    this.initialDelay = opts.initialDelay ?? 200;
    this.maxDelay = opts.maxDelay ?? 10_000;
    this.backoffMultiplier = opts.backoffMultiplier ?? 2;
    this.onSuccess = opts.onSuccess;
    this.onFailure = opts.onFailure;
  }

  /** Enqueue an async function. Returns a promise that resolves with its result or rejects after all retries. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn: fn as () => Promise<unknown>,
        retries: 0,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.tick();
    });
  }

  /** Pause processing. In-flight item completes before stopping. */
  pause(): void {
    this.paused = true;
  }

  /** Resume processing. */
  resume(): void {
    this.paused = false;
    this.tick();
  }

  /** Drain: wait until the queue is empty. */
  drain(): Promise<void> {
    if (this.queue.length === 0 && !this.running) return Promise.resolve();
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (this.queue.length === 0 && !this.running) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });
  }

  /** Number of items waiting (not counting in-flight). */
  get size(): number {
    return this.queue.length;
  }

  private tick(): void {
    if (this.paused || this.running || this.queue.length === 0) return;
    this.running = true;
    const item = this.queue.shift()!;
    this.process(item).finally(() => {
      this.running = false;
      this.tick();
    });
  }

  private async process(item: QueueItem<unknown>): Promise<void> {
    while (true) {
      try {
        const result = await item.fn();
        this.onSuccess?.(result, item.retries + 1);
        item.resolve(result);
        return;
      } catch (err) {
        item.retries++;
        if (item.retries > this.maxRetries) {
          this.onFailure?.(err, item.retries);
          item.reject(err);
          return;
        }
        const delay = Math.min(
          this.initialDelay * Math.pow(this.backoffMultiplier, item.retries - 1),
          this.maxDelay
        );
        await sleep(delay);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
