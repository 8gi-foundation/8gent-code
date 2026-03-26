/**
 * Represents the state of a token bucket.
 */
interface BucketState {
  tokens: number;
  lastRefillTime: number;
}

/**
 * Token bucket implementation for per-user API rate limiting.
 */
class TokenBucket {
  private buckets: Map<string, BucketState>;
  private capacity: number;
  private rate: number;

  /**
   * Creates a new TokenBucket instance.
   * @param capacity Maximum number of tokens in the bucket.
   * @param rate Number of tokens to add per second.
   */
  constructor(capacity: number, rate: number) {
    this.buckets = new Map();
    this.capacity = capacity;
    this.rate = rate;
  }

  /**
   * Consumes tokens from the bucket for the given identity key.
   * @param key Identity key for the user or client.
   * @param tokens Number of tokens to consume (default: 1).
   * @returns Object with allowed, remaining tokens, and resetAt timestamp.
   */
  consume(key: string, tokens: number = 1): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefillTime: now };
      this.buckets.set(key, bucket);
    }

    const elapsed = (now - bucket.lastRefillTime) / 1000;
    const added = elapsed * this.rate;
    bucket.tokens = Math.min(bucket.tokens + added, this.capacity);
    bucket.lastRefillTime = now;

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return {
        allowed: true,
        remaining: bucket.tokens,
        resetAt: now + ((this.capacity - bucket.tokens) / this.rate) * 1000
      };
    } else {
      return {
        allowed: false,
        remaining: bucket.tokens,
        resetAt: now + ((this.capacity - bucket.tokens) / this.rate) * 1000
      };
    }
  }

  /**
   * Gets the current state of the bucket for the given identity key.
   * @param key Identity key for the user or client.
   * @returns The bucket state or undefined if the key does not exist.
   */
  getState(key: string): BucketState | undefined {
    return this.buckets.get(key);
  }
}

export { TokenBucket };