/**
 * BatchProcessor - processes items in configurable batches with progress
 * tracking, per-batch error collection, and abort support.
 */

export interface BatchResult<T, R> {
  item: T;
  result?: R;
  error?: Error;
}

export interface BatchSummary<T, R> {
  processed: number;
  succeeded: number;
  failed: number;
  aborted: boolean;
  results: BatchResult<T, R>[];
  errors: Array<{ batchIndex: number; item: T; error: Error }>;
}

export type BatchCallback<T, R> = (
  batchResults: BatchResult<T, R>[],
  batchIndex: number,
  progress: { processed: number; total: number; percent: number }
) => void | Promise<void>;

export class BatchProcessor<T, R = void> {
  private abortController: AbortController;
  private onBatchCallback?: BatchCallback<T, R>;

  constructor() {
    this.abortController = new AbortController();
  }

  /** Register a callback invoked after each batch completes. */
  onBatch(callback: BatchCallback<T, R>): this {
    this.onBatchCallback = callback;
    return this;
  }

  /**
   * Process all items in batches of batchSize, calling fn for each item.
   * Errors are collected per item - a failing item does not stop the batch.
   * Call abort() to stop after the current batch finishes.
   */
  async process(
    items: T[],
    batchSize: number,
    fn: (item: T, signal: AbortSignal) => Promise<R>
  ): Promise<BatchSummary<T, R>> {
    if (batchSize < 1) throw new Error("batchSize must be >= 1");

    // Reset abort state for each run.
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const allResults: BatchResult<T, R>[] = [];
    const allErrors: Array<{ batchIndex: number; item: T; error: Error }> = [];
    let processed = 0;
    const total = items.length;
    let aborted = false;

    const batches = chunk(items, batchSize);

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      if (signal.aborted) {
        aborted = true;
        break;
      }

      const batch = batches[batchIndex];
      const batchResults: BatchResult<T, R>[] = [];

      // Run items in the batch concurrently.
      await Promise.all(
        batch.map(async (item) => {
          if (signal.aborted) {
            batchResults.push({ item });
            return;
          }
          try {
            const result = await fn(item, signal);
            batchResults.push({ item, result });
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            batchResults.push({ item, error });
            allErrors.push({ batchIndex, item, error });
          }
        })
      );

      processed += batch.length;
      allResults.push(...batchResults);

      if (this.onBatchCallback) {
        const percent = total === 0 ? 100 : Math.round((processed / total) * 100);
        await this.onBatchCallback(batchResults, batchIndex, {
          processed,
          total,
          percent,
        });
      }
    }

    const succeeded = allResults.filter((r) => r.error == null && r.result !== undefined || r.error == null).length;

    return {
      processed,
      succeeded: allResults.filter((r) => r.error == null).length,
      failed: allErrors.length,
      aborted,
      results: allResults,
      errors: allErrors,
    };
  }

  /** Signals the processor to stop after the current batch completes. */
  abort(): void {
    this.abortController.abort();
  }

  get isAborted(): boolean {
    return this.abortController.signal.aborted;
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
