/**
 * A cache with per-entry TTL and lazy eviction.
 * @template K - Type of keys
 * @template V - Type of values
 */
export class TimedCache<K, V> {
  private readonly map = new Map<K, { value: V; expires: number }>();

  /**
   * Creates a new TimedCache instance.
   * @param defaultTTL - Default time-to-live in milliseconds for entries
   */
  constructor(private readonly defaultTTL: number) {}

  /**
   * Gets a value from the cache.
   * @param key - Key to retrieve
   * @returns Value if present and not expired, otherwise undefined
   */
  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry || entry.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Sets a value in the cache.
   * @param key - Key to store
   * @param value - Value to store
   * @param ttl - Optional time-to-live in milliseconds (overrides defaultTTL)
   */
  set(key: K, value: V, ttl?: number): void {
    const expires = ttl !== undefined ? Date.now() + ttl : Date.now() + this.defaultTTL;
    this.map.set(key, { value, expires });
  }

  /**
   * Checks if a key exists in the cache and has not expired.
   * @param key - Key to check
   * @returns True if present and not expired, otherwise false
   */
  has(key: K): boolean {
    const entry = this.map.get(key);
    return entry && entry.expires >= Date.now();
  }

  /**
   * Deletes an entry from the cache.
   * @param key - Key to delete
   */
  delete(key: K): void {
    this.map.delete(key);
  }
}