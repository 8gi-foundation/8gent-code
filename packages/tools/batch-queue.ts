/**
 * A queue that batches items and processes them in batches.
 * @template T Type of items added to the queue.
 * @template R Type of results returned by the batch function.
 */
export class BatchQueue<T, R> {
  private queue: T[] = [];
  private pendingPromises: { resolve: (value: R) => void; reject: (reason: any) => void }[] = [];
  private timeoutId: number | null = null;
  private batchFn: (items: T[]) => Promise<R[]>;
  private maxSize: number;
  private maxWait: number;

  /**
   * Creates a new BatchQueue instance.
   * @param batchFn Function that processes a batch of items.
   * @param options Configuration options for the queue.
   */
  constructor(
    batchFn: (items: T[]) => Promise<R[]>,
    options: { maxSize: number; maxWait: number }
  ) {
    this.batchFn = batchFn;
    this.maxSize = options.maxSize;
    this.maxWait = options.maxWait;
  }

  /**
   * Adds an item to the queue. Returns a promise that resolves with the result.
   * @param item The item to add.
   * @returns A promise that resolves with the result of processing the item.
   */
  add(item: T): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      this.queue.push(item);
      this.pendingPromises.push({ resolve, reject });
      if (this.queue.length >= this.maxSize) {
        this.flush();
      } else if (!this.timeoutId) {
        this.timeoutId = setTimeout(() => this.flush(), this.maxWait);
      }
    });
  }

  private async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    try {
      const results = await this.batchFn(this.queue);
      for (let i = 0; i < results.length; i++) {
        this.pendingPromises[i].resolve(results[i]);
      }
    } catch (e) {
      for (let i = 0; i < this.pendingPromises.length; i++) {
        this.pendingPromises[i].reject(e);
      }
    } finally {
      this.queue = [];
      this.pendingPromises = [];
      if (this.timeoutId) {
        clearTimeout(this.timeoutId);
        this.timeoutId = null;
      }
    }
  }
}