/**
 * Retry options configuration.
 */
export interface RetryOptions {
  /**
   * Maximum number of retry attempts.
   */
  maxAttempts?: number;
  /**
   * Initial delay between retries in milliseconds.
   */
  delay?: number;
  /**
   * Backoff strategy: 'linear' or 'exponential'.
   */
  backoff?: 'linear' | 'exponential';
  /**
   * Function to determine if retry should occur on error.
   */
  shouldRetry?: (err: any) => boolean;
  /**
   * Callback invoked on each retry attempt.
   */
  onRetry?: (attempt: number, err: any) => void;
}

/**
 * Retry an async function with configurable backoff strategy.
 * @param fn - Async function to retry.
 * @param opts - Retry options.
 * @returns Result of the first successful attempt.
 */
export async function retry(fn: () => Promise<any>, opts: RetryOptions = {}): Promise<any> {
  const options = {
    maxAttempts: opts.maxAttempts ?? 3,
    delay: opts.delay ?? 1000,
    backoff: opts.backoff ?? 'exponential',
    shouldRetry: opts.shouldRetry ?? ((err) => true),
    onRetry: opts.onRetry ?? ((attempt, err) => {}),
  };

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === options.maxAttempts) {
        throw err;
      }
      if (!options.shouldRetry(err)) {
        throw err;
      }
      options.onRetry(attempt, err);
      const delay = options.backoff === 'linear'
        ? options.delay * (attempt - 1)
        : options.delay * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}