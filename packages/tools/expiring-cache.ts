/**
 * ExpiringCache - TTL-based cache with automatic expiry and refresh
 *
 * Features:
 * - Per-entry TTL (or global default)
 * - getOrRefresh: async factory pattern for cache-aside loading
 * - Background cleanup timer (optional)
 * - Standard Map-like API: get, set, delete, has, size, clear
 * - prune() to manually evict all expired entries
 */

export interface CacheEntry<V> {
  value: V;
  expiresAt: number; // ms since epoch, 0 = never
}

export interface ExpiringCacheOptions {
  /** Default TTL in milliseconds. 0 = no expiry. Default: 0 */
  defaultTtl?: number;
  /** If set, runs background cleanup every N ms */
  cleanupInterval?: number;
}

export class ExpiringCache<K, V> {
  private store = new Map<K, CacheEntry<V>>();
  private readonly defaultTtl: number;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(options: ExpiringCacheOptions = {}) {
    this.defaultTtl = options.defaultTtl ?? 0;

    if (options.cleanupInterval && options.cleanupInterval > 0) {
      this.cleanupTimer = setInterval(
        () => this.prune(),
        options.cleanupInterval
      );
      // Don't block process exit
      if (typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
        (this.cleanupTimer as NodeJS.Timeout).unref?.();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Core API
  // ---------------------------------------------------------------------------

  /** Retrieve a value. Returns undefined if missing or expired. */
  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Store a value.
   * @param ttl Override TTL in ms for this entry. 0 = no expiry.
   *            Omit to use instance default.
   */
  set(key: K, value: V, ttl?: number): this {
    const effectiveTtl = ttl !== undefined ? ttl : this.defaultTtl;
    const expiresAt = effectiveTtl > 0 ? Date.now() + effectiveTtl : 0;
    this.store.set(key, { value, expiresAt });
    return this;
  }

  /**
   * Return cached value if present and fresh, otherwise call factory,
   * store the result, and return it.
   */
  async getOrRefresh(
    key: K,
    factory: (key: K) => Promise<V> | V,
    ttl?: number
  ): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const fresh = await factory(key);
    this.set(key, fresh, ttl);
    return fresh;
  }

  /** Remove an entry. Returns true if it existed (and was not expired). */
  delete(key: K): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    this.store.delete(key);
    return !this.isExpired(entry);
  }

  /** Returns true if the key exists and has not expired. */
  has(key: K): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  /** Number of entries including potentially-expired ones not yet pruned. */
  get size(): number {
    return this.store.size;
  }

  /** Remove all entries. */
  clear(): void {
    this.store.clear();
  }

  // ---------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------

  /** Evict all expired entries. Returns count of removed entries. */
  prune(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (entry.expiresAt > 0 && entry.expiresAt <= now) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Stop the background cleanup timer if one was started. */
  destroy(): void {
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private isExpired(entry: CacheEntry<V>): boolean {
    return entry.expiresAt > 0 && entry.expiresAt <= Date.now();
  }
}
