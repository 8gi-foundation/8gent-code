/**
 * CacheMap - Map with per-entry TTL and LRU eviction.
 *
 * Extends the native Map API with:
 * - Per-entry TTL (time-to-live in ms)
 * - Max-size cap with LRU eviction
 * - getOrSet factory for cache-aside pattern
 * - touch() to refresh TTL without changing value
 * - prune() to manually sweep expired entries
 * - stats() for observability
 */

interface CacheEntry<V> {
  value: V;
  expiresAt: number; // Date.now() + ttl, or Infinity if no TTL
  lastAccessed: number;
}

export interface CacheMapOptions {
  /** Default TTL in milliseconds. Omit for no expiry. */
  defaultTtl?: number;
  /** Maximum number of entries before LRU eviction kicks in. */
  maxSize?: number;
}

export interface CacheStats {
  size: number;
  maxSize: number | undefined;
  hits: number;
  misses: number;
  evictions: number;
  expired: number;
}

export class CacheMap<K, V> {
  private entries: Map<K, CacheEntry<V>> = new Map();
  private readonly defaultTtl: number | undefined;
  private readonly maxSize: number | undefined;

  private _hits = 0;
  private _misses = 0;
  private _evictions = 0;
  private _expired = 0;

  constructor(options: CacheMapOptions = {}) {
    this.defaultTtl = options.defaultTtl;
    this.maxSize = options.maxSize;
  }

  // ---- Core Map API ----

  get size(): number {
    return this.entries.size;
  }

  has(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.delete(key);
      return false;
    }
    return true;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this._misses++;
      return undefined;
    }
    if (this.isExpired(entry)) {
      this._expired++;
      this._misses++;
      this.delete(key);
      return undefined;
    }
    entry.lastAccessed = Date.now();
    this._hits++;
    return entry.value;
  }

  set(key: K, value: V, ttl?: number): this {
    const resolvedTtl = ttl ?? this.defaultTtl;
    const now = Date.now();

    // If updating existing, remove first to re-insert (preserves LRU order).
    this.entries.delete(key);

    if (this.maxSize !== undefined && this.entries.size >= this.maxSize) {
      this.evictLru();
    }

    this.entries.set(key, {
      value,
      expiresAt: resolvedTtl !== undefined ? now + resolvedTtl : Infinity,
      lastAccessed: now,
    });

    return this;
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  // ---- Extended API ----

  /**
   * Return cached value if present, otherwise call factory, cache the result,
   * and return it. Optionally override TTL for this entry.
   */
  async getOrSet(key: K, factory: () => V | Promise<V>, ttl?: number): Promise<V> {
    const existing = this.get(key);
    if (existing !== undefined) return existing;

    const value = await factory();
    this.set(key, value, ttl);
    return value;
  }

  /**
   * Refresh the TTL on an existing key without changing its value.
   * Returns true if the key existed and was touched.
   */
  touch(key: K, ttl?: number): boolean {
    const entry = this.entries.get(key);
    if (!entry || this.isExpired(entry)) {
      if (entry) this.delete(key);
      return false;
    }
    const resolvedTtl = ttl ?? this.defaultTtl;
    entry.expiresAt = resolvedTtl !== undefined ? Date.now() + resolvedTtl : Infinity;
    entry.lastAccessed = Date.now();
    return true;
  }

  /**
   * Remove all entries whose TTL has elapsed. Returns count removed.
   */
  prune(): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry)) {
        this.entries.delete(key);
        this._expired++;
        removed++;
      }
    }
    return removed;
  }

  /** Observability snapshot. */
  stats(): CacheStats {
    return {
      size: this.entries.size,
      maxSize: this.maxSize,
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      expired: this._expired,
    };
  }

  // ---- Iteration (skips expired entries) ----

  *keys(): IterableIterator<K> {
    for (const [k, entry] of this.entries) {
      if (!this.isExpired(entry)) yield k;
    }
  }

  *values(): IterableIterator<V> {
    for (const [, entry] of this.entries) {
      if (!this.isExpired(entry)) yield entry.value;
    }
  }

  *[Symbol.iterator](): IterableIterator<[K, V]> {
    for (const [k, entry] of this.entries) {
      if (!this.isExpired(entry)) yield [k, entry.value];
    }
  }

  // ---- Private helpers ----

  private isExpired(entry: CacheEntry<V>): boolean {
    return entry.expiresAt < Date.now();
  }

  private evictLru(): void {
    let lruKey: K | undefined;
    let lruTime = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.lastAccessed < lruTime) {
        lruTime = entry.lastAccessed;
        lruKey = key;
      }
    }
    if (lruKey !== undefined) {
      this.entries.delete(lruKey);
      this._evictions++;
    }
  }
}
