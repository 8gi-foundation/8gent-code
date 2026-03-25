/**
 * RequestBatcher - batches multiple individual requests into single API calls.
 *
 * Usage:
 *   const batcher = new RequestBatcher<Input, Output>({
 *     maxBatchSize: 20,
 *     windowMs: 50,
 *     executor: async (inputs) => myApiCall(inputs),
 *   });
 *
 *   const result = await batcher.request(myInput);
 */

export interface BatcherOptions<TInput, TOutput> {
  /** Maximum number of requests per batch. Default: 25. */
  maxBatchSize?: number;
  /** Max milliseconds to wait before flushing an incomplete batch. Default: 50. */
  windowMs?: number;
  /** Function that handles a batch of inputs and returns matching outputs. */
  executor: (inputs: TInput[]) => Promise<TOutput[]>;
  /** Max retry attempts on batch failure. Default: 2. */
  maxRetries?: number;
  /** Base delay (ms) between retries. Default: 100. */
  retryDelayMs?: number;
}

interface PendingRequest<TInput, TOutput> {
  input: TInput;
  resolve: (value: TOutput) => void;
  reject: (reason: unknown) => void;
}

export class RequestBatcher<TInput, TOutput> {
  private queue: PendingRequest<TInput, TOutput>[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  private readonly maxBatchSize: number;
  private readonly windowMs: number;
  private readonly executor: (inputs: TInput[]) => Promise<TOutput[]>;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(options: BatcherOptions<TInput, TOutput>) {
    this.maxBatchSize = options.maxBatchSize ?? 25;
    this.windowMs = options.windowMs ?? 50;
    this.executor = options.executor;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 100;
  }

  /** Enqueue a single request. Resolves when the batch returns. */
  request(input: TInput): Promise<TOutput> {
    return new Promise<TOutput>((resolve, reject) => {
      this.queue.push({ input, resolve, reject });

      if (this.queue.length >= this.maxBatchSize) {
        this.flush();
      } else if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), this.windowMs);
      }
    });
  }

  /** Force-flush any queued requests immediately. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.maxBatchSize);
    const inputs = batch.map((r) => r.input);

    try {
      const outputs = await this.executeWithRetry(inputs);

      if (outputs.length !== batch.length) {
        const err = new Error(
          `Batch executor returned ${outputs.length} results for ${batch.length} inputs`
        );
        batch.forEach((r) => r.reject(err));
        return;
      }

      batch.forEach((r, i) => r.resolve(outputs[i]));
    } catch (err) {
      batch.forEach((r) => r.reject(err));
    }
  }

  /** Drain all remaining queued requests in batches. */
  async drain(): Promise<void> {
    while (this.queue.length > 0) {
      await this.flush();
    }
  }

  private async executeWithRetry(inputs: TInput[]): Promise<TOutput[]> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.executor(inputs);
      } catch (err) {
        lastError = err;
        if (attempt < this.maxRetries) {
          await sleep(this.retryDelayMs * 2 ** attempt);
        }
      }
    }

    throw lastError;
  }

  /** Number of requests currently waiting in the queue. */
  get pendingCount(): number {
    return this.queue.length;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
