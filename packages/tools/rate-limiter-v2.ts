/**
 * Token bucket rate limiter with sliding window refill.
 * Zero dependencies.
 */

export interface RateLimiterOptions {
  maxTokens: number;
  refillRate: number;       // tokens added per refill interval
  refillIntervalMs: number; // how often to refill (ms)
}

export interface RateLimiter {
  tryConsume(tokens?: number): boolean;
  waitForToken(): Promise<void>;
  getRemaining(): number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { maxTokens, refillRate, refillIntervalMs } = options;

  let tokens = maxTokens;
  let lastRefill = Date.now();

  function refill(): void {
    const now = Date.now();
    const elapsed = now - lastRefill;
    const intervals = Math.floor(elapsed / refillIntervalMs);
    if (intervals > 0) {
      tokens = Math.min(maxTokens, tokens + intervals * refillRate);
      lastRefill += intervals * refillIntervalMs;
    }
  }

  function tryConsume(count = 1): boolean {
    refill();
    if (tokens >= count) {
      tokens -= count;
      return true;
    }
    return false;
  }

  function getRemaining(): number {
    refill();
    return tokens;
  }

  function waitForToken(): Promise<void> {
    return new Promise((resolve) => {
      if (tryConsume(1)) {
        resolve();
        return;
      }
      const poll = setInterval(() => {
        if (tryConsume(1)) {
          clearInterval(poll);
          resolve();
        }
      }, Math.max(1, refillIntervalMs / refillRate));
    });
  }

  return { tryConsume, waitForToken, getRemaining };
}
