/**
 * 8gent Code - Token Bucket Rate Limiter for API Calls
 *
 * Configurable per-endpoint token bucket with request queuing.
 * Covers OpenRouter, GitHub, and Telegram APIs.
 * No external dependencies.
 */

export interface BucketConfig {
  /** Maximum tokens (requests) the bucket can hold */
  capacity: number;
  /** Tokens refilled per second */
  refillRate: number;
}

/** Built-in presets for known APIs */
export const API_PRESETS: Record<string, BucketConfig> = {
  'openrouter': { capacity: 60, refillRate: 1 },       // 60 req/min
  'github': { capacity: 30, refillRate: 0.5 },          // 30 req/min
  'telegram': { capacity: 30, refillRate: 0.5 },        // 30 req/min
};

interface QueuedRequest {
  resolve: () => void;
  reject: (err: Error) => void;
  abortSignal?: AbortSignal;
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private queue: QueuedRequest[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private config: BucketConfig) {
    this.tokens = config.capacity;
    this.lastRefill = Date.now();
  }

  /** Refill tokens based on elapsed time */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(
      this.config.capacity,
      this.tokens + elapsed * this.config.refillRate,
    );
    this.lastRefill = now;
  }

  /** Try to consume one token. Returns true if consumed. */
  private tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Time in ms until next token is available */
  private msUntilToken(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const deficit = 1 - this.tokens;
    return Math.ceil((deficit / this.config.refillRate) * 1000);
  }

  /** Drain queued requests as tokens become available */
  private scheduleDrain(): void {
    if (this.drainTimer || this.queue.length === 0) return;
    const wait = this.msUntilToken();
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drain();
    }, wait);
  }

  private drain(): void {
    while (this.queue.length > 0) {
      // Drop aborted requests
      const head = this.queue[0];
      if (head.abortSignal?.aborted) {
        this.queue.shift();
        head.reject(new Error('Request aborted while queued'));
        continue;
      }
      if (this.tryConsume()) {
        this.queue.shift()!.resolve();
      } else {
        break;
      }
    }
    if (this.queue.length > 0) this.scheduleDrain();
  }

  /**
   * Acquire a token. Resolves immediately if available,
   * otherwise queues until a token is ready.
   */
  acquire(abortSignal?: AbortSignal): Promise<void> {
    if (this.tryConsume()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject, abortSignal });
      this.scheduleDrain();
    });
  }

  /** Number of requests waiting in the queue */
  get pending(): number {
    return this.queue.length;
  }

  /** Current token count (fractional) */
  get available(): number {
    this.refill();
    return this.tokens;
  }
}

/**
 * API Rate Limiter - manages per-endpoint token buckets.
 *
 * Usage:
 *   const limiter = new ApiRateLimiter();
 *   await limiter.acquire('openrouter');  // waits if at limit
 *   const res = await fetch(openRouterUrl, ...);
 */
export class ApiRateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private configs: Record<string, BucketConfig>;

  constructor(overrides?: Record<string, Partial<BucketConfig>>) {
    this.configs = { ...API_PRESETS };
    if (overrides) {
      for (const [key, partial] of Object.entries(overrides)) {
        const base = this.configs[key] ?? { capacity: 60, refillRate: 1 };
        this.configs[key] = { ...base, ...partial };
      }
    }
  }

  private getBucket(endpoint: string): TokenBucket {
    let bucket = this.buckets.get(endpoint);
    if (!bucket) {
      const config = this.configs[endpoint] ?? { capacity: 60, refillRate: 1 };
      bucket = new TokenBucket(config);
      this.buckets.set(endpoint, bucket);
    }
    return bucket;
  }

  /** Wait for a token, then proceed. Queues if at limit. */
  acquire(endpoint: string, abortSignal?: AbortSignal): Promise<void> {
    return this.getBucket(endpoint).acquire(abortSignal);
  }

  /** Check pending queue length for an endpoint */
  pending(endpoint: string): number {
    return this.buckets.get(endpoint)?.pending ?? 0;
  }

  /** Check available tokens for an endpoint */
  available(endpoint: string): number {
    return this.buckets.get(endpoint)?.available ?? 0;
  }
}
