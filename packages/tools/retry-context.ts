/**
 * RetryContext - tracks retry state across multiple attempts.
 * Passed to retry callbacks so handlers can make decisions based on history.
 */

export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  onRetry?: (ctx: RetryContext) => void | Promise<void>;
}

export interface AttemptError {
  attempt: number;
  error: Error;
  timestamp: number;
}

export class RetryContext {
  readonly startTime: number;
  private _attempt: number = 1;
  private _errors: AttemptError[] = [];
  private _notes: string[] = [];
  private _maxAttempts: number;

  constructor(maxAttempts: number = 3) {
    this._maxAttempts = maxAttempts;
    this.startTime = Date.now();
  }

  /** Current attempt number (1-indexed). */
  get attempt(): number {
    return this._attempt;
  }

  /** Max attempts configured. */
  get maxAttempts(): number {
    return this._maxAttempts;
  }

  /** Milliseconds elapsed since first attempt. */
  get elapsedMs(): number {
    return Date.now() - this.startTime;
  }

  /** All errors from previous attempts. */
  get errors(): ReadonlyArray<AttemptError> {
    return this._errors;
  }

  /** Last error encountered, or null on first attempt. */
  get lastError(): Error | null {
    if (this._errors.length === 0) return null;
    return this._errors[this._errors.length - 1].error;
  }

  /** True if this is the first attempt (no prior failures). */
  get isFirstAttempt(): boolean {
    return this._attempt === 1;
  }

  /** True if this is the last allowed attempt. */
  get isLastAttempt(): boolean {
    return this._attempt >= this._maxAttempts;
  }

  /** Debug notes added by the caller. */
  get notes(): ReadonlyArray<string> {
    return this._notes;
  }

  /** Add a debug note for observability. */
  addNote(note: string): void {
    this._notes.push(`[attempt ${this._attempt}] ${note}`);
  }

  /** Record a failure and advance to the next attempt. Internal use. */
  _recordFailure(error: Error): void {
    this._errors.push({
      attempt: this._attempt,
      error,
      timestamp: Date.now(),
    });
    this._attempt++;
  }

  /** Summary snapshot for logging. */
  toJSON(): Record<string, unknown> {
    return {
      attempt: this._attempt,
      maxAttempts: this._maxAttempts,
      elapsedMs: this.elapsedMs,
      errorCount: this._errors.length,
      lastError: this.lastError?.message ?? null,
      notes: this._notes,
    };
  }
}

/**
 * withRetryContext - wraps an async function with retry logic,
 * passing a RetryContext to each invocation.
 *
 * @example
 * const result = await withRetryContext(
 *   async (ctx) => {
 *     if (!ctx.isFirstAttempt) ctx.addNote("retrying after timeout");
 *     return await fetchSomething();
 *   },
 *   { maxAttempts: 3, delayMs: 500 }
 * );
 */
export async function withRetryContext<T>(
  fn: (ctx: RetryContext) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxAttempts = 3, delayMs = 0, onRetry } = options;
  const ctx = new RetryContext(maxAttempts);

  while (true) {
    try {
      return await fn(ctx);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      ctx._recordFailure(error);

      if (ctx.attempt > maxAttempts) {
        throw error;
      }

      if (onRetry) {
        await onRetry(ctx);
      }

      if (delayMs > 0) {
        await new Promise((res) => setTimeout(res, delayMs));
      }
    }
  }
}
