/**
 * asyncPool v2 - Concurrent async execution with error modes, progress, and abort support.
 *
 * Runs up to `concurrency` promises in parallel.
 * Returns ordered results matching the input array.
 */

export type ErrorMode = "fail-fast" | "collect" | "ignore";

export interface AsyncPoolOptions<T> {
  /** Max concurrent tasks. Default: 5 */
  concurrency?: number;
  /** How to handle errors. Default: "fail-fast" */
  errorMode?: ErrorMode;
  /** Called after each item resolves or is skipped */
  onProgress?: (completed: number, total: number, index: number) => void;
  /** Called when an item rejects (all modes except silent ignore) */
  onError?: (error: unknown, index: number) => void;
  /** AbortSignal to cancel remaining tasks */
  signal?: AbortSignal;
}

export type PoolResult<T> =
  | { ok: true; value: T; index: number }
  | { ok: false; error: unknown; index: number };

export class AsyncPoolAbortError extends Error {
  constructor() {
    super("async-pool: aborted");
    this.name = "AsyncPoolAbortError";
  }
}

/**
 * Run an async function over all items with bounded concurrency.
 *
 * @param items   Input array
 * @param fn      Async function to apply to each item
 * @param options Configuration (concurrency, errorMode, onProgress, onError, signal)
 * @returns       Array of results in input order
 *
 * - "fail-fast": first rejection throws immediately (default)
 * - "collect":   all items run; returns PoolResult<T>[] (mix of ok/error)
 * - "ignore":    errors silently dropped; undefined for failed slots
 */
export async function asyncPool<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  options: AsyncPoolOptions<T> = {}
): Promise<R[] | PoolResult<R>[]> {
  const {
    concurrency = 5,
    errorMode = "fail-fast",
    onProgress,
    onError,
    signal,
  } = options;

  const total = items.length;
  if (total === 0) return [];

  const results: (R | undefined)[] = new Array(total);
  const collectedResults: PoolResult<R>[] = new Array(total);
  let completed = 0;
  let aborted = false;

  if (signal) {
    signal.addEventListener("abort", () => {
      aborted = true;
    });
    if (signal.aborted) {
      throw new AsyncPoolAbortError();
    }
  }

  const execute = async (index: number): Promise<void> => {
    if (aborted) return;

    try {
      const value = await fn(items[index], index);
      results[index] = value;
      if (errorMode === "collect") {
        collectedResults[index] = { ok: true, value, index };
      }
    } catch (error) {
      if (errorMode === "fail-fast") {
        aborted = true;
        throw error;
      }
      onError?.(error, index);
      if (errorMode === "collect") {
        collectedResults[index] = { ok: false, error, index };
      }
      // "ignore" - slot stays undefined
    } finally {
      completed++;
      onProgress?.(completed, total, index);
    }
  };

  // Slide a window of `concurrency` tasks across the items array.
  const queue = items.map((_, i) => i);
  const inFlight = new Set<Promise<void>>();

  for (const index of queue) {
    if (aborted) break;

    const task = execute(index).then(() => {
      inFlight.delete(task);
    });
    inFlight.add(task);

    if (inFlight.size >= concurrency) {
      await Promise.race(inFlight);
    }
  }

  await Promise.all(inFlight);

  if (aborted && signal?.aborted) {
    throw new AsyncPoolAbortError();
  }

  if (errorMode === "collect") {
    return collectedResults;
  }

  return results as R[];
}
