/**
 * 8gent Code - Token Bucket Rate Limiter
 *
 * Per-key token bucket rate limiting with request queuing.
 * Zero external dependencies.
 *
 * Algorithm: Token bucket
 * - Each key has a bucket with capacity `burst` tokens.
 * - Tokens refill at `rate` tokens per second.
 * - Each request consumes 1 token.
 * - Requests that exceed capacity are queued up to `maxQueue` depth.
 * - Queued requests are drained as tokens refill.
 */

export interface BucketConfig {
  /** Sustained requests per second (refill rate) */
  rate: number;
  /** Max burst capacity (bucket size) */
  burst: number;
  /** Max number of requests to queue when bucket is empty. 0 = no queue. */
  maxQueue: number;
}

export interface AcquireResult {
  /** Whether the token was granted immediately */
  granted: boolean;
  /** If queued, resolves when the token is eventually granted */
  wait: Promise<void>;
  /** Estimated wait time in milliseconds (0 if granted immediately) */
  estimatedWaitMs: number;
}

interface BucketState {
  tokens: number;
  lastRefill: number;
  queue: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    enqueuedAt: number;
  }>;
}

/** Pre-built preset configs for common integrations */
export const PRESETS: Record<string, BucketConfig> = {
  /**
   * Ollama - local inference, generous limits.
   * 10 rps burst keeps the model responsive.
   */
  ollama: {
    rate: 5,
    burst: 10,
    maxQueue: 20,
  },

  /**
   * OpenRouter free tier - 20 req/min across all models.
   * ~0.33 rps sustained, allow short bursts of 3.
   */
  "openrouter-free": {
    rate: 0.33,
    burst: 3,
    maxQueue: 10,
  },

  /**
   * OpenRouter paid tier - 200 req/min default.
   * ~3.3 rps sustained, burst of 20.
   */
  "openrouter-paid": {
    rate: 3.33,
    burst: 20,
    maxQueue: 50,
  },

  /**
   * GitHub REST API - 5000 req/hour for authenticated users.
   * ~1.39 rps sustained, burst of 30.
   */
  github: {
    rate: 1.39,
    burst: 30,
    maxQueue: 15,
  },

  /**
   * GitHub Search API - 30 req/min.
   * 0.5 rps, small burst.
   */
  "github-search": {
    rate: 0.5,
    burst: 5,
    maxQueue: 10,
  },

  /**
   * Generic LLM - conservative default for unknown providers.
   */
  llm: {
    rate: 1,
    burst: 5,
    maxQueue: 20,
  },
};

export class RateLimiter {
  private buckets: Map<string, BucketState> = new Map();
  private drainTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(private configs: Record<string, BucketConfig> = {}) {}

  /** Register or update a config for a named key. */
  configure(key: string, config: BucketConfig): void {
    this.configs[key] = config;
  }

  /** Load a preset config for a named key. */
  preset(key: string, presetName: keyof typeof PRESETS): void {
    const p = PRESETS[presetName];
    if (!p) throw new Error(`Unknown preset: ${presetName}`);
    this.configs[key] = { ...p };
  }

  /**
   * Acquire a token for the given key.
   *
   * - If a token is available immediately, `granted` is true and
   *   `wait` resolves instantly.
   * - If the bucket is empty but queue has room, `granted` is false
   *   and `wait` resolves when a token becomes available.
   * - If the queue is full, `wait` rejects with a RateLimitError.
   */
  acquire(key: string): AcquireResult {
    const config = this.resolveConfig(key);
    const state = this.getOrCreateBucket(key, config);

    this.refill(state, config);

    if (state.tokens >= 1) {
      state.tokens -= 1;
      return { granted: true, wait: Promise.resolve(), estimatedWaitMs: 0 };
    }

    // Bucket empty - try to queue
    if (config.maxQueue === 0 || state.queue.length >= config.maxQueue) {
      const err = new RateLimitError(
        key,
        config,
        state.queue.length,
        this.estimateWaitMs(state, config, state.queue.length + 1)
      );
      return {
        granted: false,
        wait: Promise.reject(err),
        estimatedWaitMs: err.estimatedWaitMs,
      };
    }

    const estimatedWaitMs = this.estimateWaitMs(state, config, state.queue.length + 1);
    const wait = new Promise<void>((resolve, reject) => {
      state.queue.push({ resolve, reject, enqueuedAt: Date.now() });
    });

    this.scheduleDrain(key, config, state);

    return { granted: false, wait, estimatedWaitMs };
  }

  /**
   * Check if a token is available without consuming it.
   * Returns true if the next acquire() would be granted immediately.
   */
  canAcquire(key: string): boolean {
    const config = this.resolveConfig(key);
    const state = this.getOrCreateBucket(key, config);
    this.refill(state, config);
    return state.tokens >= 1;
  }

  /** Current token count for a key (fractional). */
  tokens(key: string): number {
    const config = this.resolveConfig(key);
    const state = this.getOrCreateBucket(key, config);
    this.refill(state, config);
    return state.tokens;
  }

  /** Queue depth for a key. */
  queueDepth(key: string): number {
    return this.buckets.get(key)?.queue.length ?? 0;
  }

  /** Snapshot of all active buckets for observability. */
  stats(): Record<string, { tokens: number; queue: number }> {
    const out: Record<string, { tokens: number; queue: number }> = {};
    for (const [key, state] of this.buckets) {
      const config = this.resolveConfig(key);
      this.refill(state, config);
      out[key] = { tokens: Math.floor(state.tokens), queue: state.queue.length };
    }
    return out;
  }

  /** Reset a specific key's bucket and drain its queue with an error. */
  reset(key: string): void {
    const state = this.buckets.get(key);
    if (state) {
      for (const item of state.queue) {
        item.reject(new Error(`Rate limiter reset for key: ${key}`));
      }
      state.queue.length = 0;
    }
    this.buckets.delete(key);
    const timer = this.drainTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.drainTimers.delete(key);
    }
  }

  /** Reset all keys. */
  resetAll(): void {
    for (const key of [...this.buckets.keys()]) {
      this.reset(key);
    }
  }

  // --- private ---

  private resolveConfig(key: string): BucketConfig {
    if (this.configs[key]) return this.configs[key];
    if (PRESETS[key]) return PRESETS[key];
    return { rate: 10, burst: 20, maxQueue: 50 };
  }

  private getOrCreateBucket(key: string, config: BucketConfig): BucketState {
    let state = this.buckets.get(key);
    if (!state) {
      state = { tokens: config.burst, lastRefill: Date.now(), queue: [] };
      this.buckets.set(key, state);
    }
    return state;
  }

  private refill(state: BucketState, config: BucketConfig): void {
    const now = Date.now();
    const elapsed = (now - state.lastRefill) / 1000;
    state.tokens = Math.min(config.burst, state.tokens + elapsed * config.rate);
    state.lastRefill = now;
  }

  private estimateWaitMs(state: BucketState, config: BucketConfig, position: number): number {
    const deficit = position - state.tokens;
    if (deficit <= 0) return 0;
    return Math.ceil((deficit / config.rate) * 1000);
  }

  private scheduleDrain(key: string, config: BucketConfig, state: BucketState): void {
    if (this.drainTimers.has(key)) return;

    const msPerToken = (1 / config.rate) * 1000;

    const tick = () => {
      this.drainTimers.delete(key);

      const currentState = this.buckets.get(key);
      if (!currentState || currentState.queue.length === 0) return;

      this.refill(currentState, config);

      while (currentState.queue.length > 0 && currentState.tokens >= 1) {
        currentState.tokens -= 1;
        const item = currentState.queue.shift()!;
        item.resolve();
      }

      if (currentState.queue.length > 0) {
        const timer = setTimeout(tick, msPerToken);
        this.drainTimers.set(key, timer);
      }
    };

    const timer = setTimeout(tick, msPerToken);
    this.drainTimers.set(key, timer);
  }
}

export class RateLimitError extends Error {
  constructor(
    public readonly key: string,
    public readonly config: BucketConfig,
    public readonly queueDepth: number,
    public readonly estimatedWaitMs: number
  ) {
    super(
      `Rate limit exceeded for "${key}": queue full (${queueDepth}/${config.maxQueue}). ` +
        `Limit: ${config.rate} rps, burst: ${config.burst}. ` +
        `Estimated wait: ${estimatedWaitMs}ms.`
    );
    this.name = "RateLimitError";
  }
}
