/**
 * Parallel array operations with configurable concurrency and abort support.
 *
 * Provides map, filter, forEach, and reduce over arrays where async callbacks
 * run up to `concurrency` at a time. All functions respect AbortSignal and
 * throw an AbortError if the signal fires mid-flight.
 */

/** Default maximum number of concurrent callbacks. */
const DEFAULT_CONCURRENCY = 4;

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException(
    typeof reason === "string" ? reason : "The operation was aborted",
    "AbortError"
  );
}

/**
 * Run an async worker pool over a slice of work. Items are consumed from
 * the shared index so workers never duplicate effort.
 */
async function runPool<T, R>(
  items: readonly T[],
  fn: (item: T, index: number, signal?: AbortSignal) => Promise<R>,
  concurrency: number,
  signal?: AbortSignal
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      throwIfAborted(signal);
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index, signal);
      throwIfAborted(signal);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Map over `items` calling `fn` on up to `concurrency` items at once.
 * Order is preserved. Throws AbortError if `signal` fires.
 *
 * @param items      Source array.
 * @param fn         Async transform. Receives item, index, and optional signal.
 * @param concurrency Max parallel calls (default: 4).
 * @param signal     Optional AbortSignal for cancellation.
 */
export async function parallelMap<T, R>(
  items: readonly T[],
  fn: (item: T, index: number, signal?: AbortSignal) => Promise<R>,
  concurrency: number = DEFAULT_CONCURRENCY,
  signal?: AbortSignal
): Promise<R[]> {
  if (items.length === 0) return [];
  throwIfAborted(signal);
  return runPool(items, fn, concurrency, signal);
}

/**
 * Filter `items` by running the async predicate with up to `concurrency`
 * calls at once. Preserves original order of passing items.
 *
 * @param items      Source array.
 * @param fn         Async predicate. Return true to keep the item.
 * @param concurrency Max parallel calls (default: 4).
 * @param signal     Optional AbortSignal for cancellation.
 */
export async function parallelFilter<T>(
  items: readonly T[],
  fn: (item: T, index: number, signal?: AbortSignal) => Promise<boolean>,
  concurrency: number = DEFAULT_CONCURRENCY,
  signal?: AbortSignal
): Promise<T[]> {
  if (items.length === 0) return [];
  throwIfAborted(signal);
  const flags = await runPool(items, fn, concurrency, signal);
  return items.filter((_, i) => flags[i]);
}

/**
 * Call `fn` on every item in `items` with up to `concurrency` calls in
 * flight at once. Useful for side effects. Throws on abort or first error.
 *
 * @param items      Source array.
 * @param fn         Async side-effect callback.
 * @param concurrency Max parallel calls (default: 4).
 * @param signal     Optional AbortSignal for cancellation.
 */
export async function parallelForEach<T>(
  items: readonly T[],
  fn: (item: T, index: number, signal?: AbortSignal) => Promise<void>,
  concurrency: number = DEFAULT_CONCURRENCY,
  signal?: AbortSignal
): Promise<void> {
  if (items.length === 0) return;
  throwIfAborted(signal);
  await runPool(items, fn, concurrency, signal);
}

/**
 * Reduce `items` using an async `fn`. The reduction is batched: up to
 * `concurrency` independent pairs are processed in each pass, then
 * intermediate results are reduced again until one value remains. This
 * means `fn` must be associative for parallel reduction to be correct.
 *
 * Falls back to sequential reduction when `concurrency` is 1.
 *
 * @param items      Source array.
 * @param fn         Async reducer - must be associative for parallel use.
 * @param init       Initial accumulator value.
 * @param concurrency Max parallel calls per pass (default: 4).
 * @param signal     Optional AbortSignal for cancellation.
 */
export async function parallelReduce<T, R>(
  items: readonly T[],
  fn: (accumulator: R, item: T, index: number, signal?: AbortSignal) => Promise<R>,
  init: R,
  concurrency: number = DEFAULT_CONCURRENCY,
  signal?: AbortSignal
): Promise<R> {
  if (items.length === 0) return init;
  throwIfAborted(signal);

  // Sequential path - safe for non-associative reducers.
  if (concurrency === 1) {
    let acc = init;
    for (let i = 0; i < items.length; i++) {
      throwIfAborted(signal);
      acc = await fn(acc, items[i], i, signal);
    }
    return acc;
  }

  // Parallel path - process chunks then reduce intermediates.
  const chunkSize = Math.ceil(items.length / concurrency);
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize) as T[]);
  }

  const partials = await parallelMap(
    chunks,
    async (chunk, _ci, sig) => {
      let acc = init;
      for (let i = 0; i < chunk.length; i++) {
        throwIfAborted(sig);
        acc = await fn(acc, chunk[i], i, sig);
      }
      return acc;
    },
    concurrency,
    signal
  );

  // Merge partial results sequentially (generic merge via fn with init).
  let result = init;
  for (const partial of partials) {
    throwIfAborted(signal);
    result = await fn(result, partial as unknown as T, 0, signal);
  }
  return result;
}
