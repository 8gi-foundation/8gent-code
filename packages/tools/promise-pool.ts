/**
 * PromisePool - runs async operations with configurable concurrency limits.
 * Supports progress tracking, error collection, and queue overflow handling.
 */

export interface PoolOptions {
  concurrency: number;
  onProgress?: (completed: number, total: number, item: unknown) => void;
  continueOnError?: boolean;
}

export interface PoolResult<T> {
  results: Array<{ index: number; value: T } | { index: number; error: unknown }>;
  errors: Array<{ index: number; error: unknown }>;
  values: T[];
}

export class PromisePool {
  private concurrency: number;
  private onProgress?: (completed: number, total: number, item: unknown) => void;
  private continueOnError: boolean;

  constructor(options: PoolOptions) {
    if (options.concurrency < 1) throw new RangeError("concurrency must be >= 1");
    this.concurrency = options.concurrency;
    this.onProgress = options.onProgress;
    this.continueOnError = options.continueOnError ?? true;
  }

  /**
   * Run fn over each item, up to concurrency tasks at once.
   * Collects all results and errors - never throws unless continueOnError is false
   * and an error occurs.
   */
  async map<T, R>(
    items: T[],
    fn: (item: T, index: number) => Promise<R>
  ): Promise<PoolResult<R>> {
    const total = items.length;
    const results: PoolResult<R>["results"] = [];
    const errors: PoolResult<R>["errors"] = [];
    let completed = 0;
    let nextIndex = 0;

    const runNext = async (): Promise<void> => {
      while (nextIndex < total) {
        const index = nextIndex++;
        const item = items[index];
        try {
          const value = await fn(item, index);
          results.push({ index, value });
          completed++;
          this.onProgress?.(completed, total, item);
        } catch (error) {
          errors.push({ index, error });
          results.push({ index, error });
          completed++;
          this.onProgress?.(completed, total, item);
          if (!this.continueOnError) throw error;
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(this.concurrency, total) },
      () => runNext()
    );

    await Promise.all(workers);

    const values = results
      .filter((r): r is { index: number; value: R } => "value" in r)
      .sort((a, b) => a.index - b.index)
      .map((r) => r.value);

    return { results, errors, values };
  }

  /**
   * forEach variant - same pool semantics, no return values collected.
   */
  async forEach<T>(
    items: T[],
    fn: (item: T, index: number) => Promise<void>
  ): Promise<{ errors: Array<{ index: number; error: unknown }> }> {
    const { errors } = await this.map(items, fn);
    return { errors };
  }
}

/**
 * Functional helper - map items through fn with a concurrency cap.
 * Returns values in original order. Throws on first error by default.
 *
 * @example
 * const results = await mapPool(urls, fetch, 5);
 */
export async function mapPool<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
  onProgress?: (completed: number, total: number) => void
): Promise<R[]> {
  const pool = new PromisePool({
    concurrency,
    continueOnError: false,
    onProgress: onProgress ? (c, t) => onProgress(c, t) : undefined,
  });
  const { values } = await pool.map(items, fn);
  return values;
}

/**
 * Like mapPool but collects errors instead of throwing.
 */
export async function mapPoolSafe<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number
): Promise<PoolResult<R>> {
  const pool = new PromisePool({ concurrency, continueOnError: true });
  return pool.map(items, fn);
}
