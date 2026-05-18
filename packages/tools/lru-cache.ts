/**
 * Generic LRU cache with TTL support, hit/miss stats, and eviction callback.
 * Zero dependencies.
 */

export interface LRUCacheOptions<K, V> {
  /** Maximum number of entries. Default: 100 */
  maxSize?: number;
  /** Time-to-live in milliseconds. 0 = no expiry. Default: 0 */
  ttl?: number;
  /** Called with (key, value) when an entry is evicted (capacity or TTL). */
  onEvict?: (key: K, value: V) => void;
}

interface Entry<V> {
  value: V;
  expiresAt: number; // 0 = never
  prev: string | null;
  next: string | null;
}

export interface LRUCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  hitRate: number;
  missRate: number;
}

/**
 * LRU cache with optional per-entry TTL and eviction callbacks.
 *
 * Internally uses a doubly-linked list (via serialised string keys) and a
 * Map so that get/set/delete are all O(1).
 */
export class LRUCache<K = string, V = unknown> {
  private readonly maxSize: number;
  private readonly ttl: number;
  private readonly onEvict?: (key: K, value: V) => void;

  // Store entries keyed by serialised key
  private readonly map = new Map<string, Entry<V>>();
  // Original key objects (so onEvict receives the actual K, not the string)
  private readonly keys = new Map<string, K>();

  // Doubly-linked list sentinels (most-recently-used <-> least-recently-used)
  private head: string | null = null; // MRU end
  private tail: string | null = null; // LRU end

  private _hits = 0;
  private _misses = 0;
  private _evictions = 0;

  constructor(options: LRUCacheOptions<K, V> = {}) {
    this.maxSize = Math.max(1, options.maxSize ?? 100);
    this.ttl = options.ttl ?? 0;
    this.onEvict = options.onEvict;
  }

  // ---- Public API ----

  get(key: K): V | undefined {
    const sk = this.serialize(key);
    const entry = this.map.get(sk);

    if (!entry) {
      this._misses++;
      return undefined;
    }

    if (this.isExpired(entry)) {
      this._misses++;
      this.remove(sk);
      return undefined;
    }

    this._hits++;
    this.moveToHead(sk, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlOverride?: number): this {
    const sk = this.serialize(key);
    const expiresAt = this.computeExpiry(ttlOverride);
    const existing = this.map.get(sk);

    if (existing) {
      existing.value = value;
      existing.expiresAt = expiresAt;
      this.moveToHead(sk, existing);
      return this;
    }

    const entry: Entry<V> = { value, expiresAt, prev: null, next: this.head };
    this.map.set(sk, entry);
    this.keys.set(sk, key);
    this.prependToHead(sk, entry);

    if (this.map.size > this.maxSize) {
      this.evictTail();
    }

    return this;
  }

  has(key: K): boolean {
    const sk = this.serialize(key);
    const entry = this.map.get(sk);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.remove(sk);
      return false;
    }
    return true;
  }

  delete(key: K): boolean {
    const sk = this.serialize(key);
    if (!this.map.has(sk)) return false;
    this.remove(sk);
    return true;
  }

  clear(): void {
    for (const [sk, entry] of this.map) {
      this.fireEvict(sk, entry.value);
    }
    this.map.clear();
    this.keys.clear();
    this.head = null;
    this.tail = null;
  }

  /** Removes all expired entries without counting them as evictions. */
  purgeExpired(): number {
    const now = Date.now();
    let purged = 0;
    for (const [sk, entry] of this.map) {
      if (entry.expiresAt > 0 && now >= entry.expiresAt) {
        this.remove(sk);
        purged++;
      }
    }
    return purged;
  }

  get size(): number {
    return this.map.size;
  }

  stats(): LRUCacheStats {
    const total = this._hits + this._misses;
    return {
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      size: this.map.size,
      hitRate: total === 0 ? 0 : this._hits / total,
      missRate: total === 0 ? 0 : this._misses / total,
    };
  }

  resetStats(): void {
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }

  // ---- Linked-list helpers ----

  private prependToHead(sk: string, entry: Entry<V>): void {
    entry.prev = null;
    entry.next = this.head;

    if (this.head !== null) {
      const headEntry = this.map.get(this.head)!;
      headEntry.prev = sk;
    }

    this.head = sk;

    if (this.tail === null) {
      this.tail = sk;
    }
  }

  private moveToHead(sk: string, entry: Entry<V>): void {
    if (this.head === sk) return; // already MRU
    this.unlink(sk, entry);
    entry.prev = null;
    entry.next = this.head;

    if (this.head !== null) {
      const headEntry = this.map.get(this.head)!;
      headEntry.prev = sk;
    }

    this.head = sk;
  }

  private unlink(sk: string, entry: Entry<V>): void {
    if (entry.prev !== null) {
      const prevEntry = this.map.get(entry.prev)!;
      prevEntry.next = entry.next;
    } else {
      this.head = entry.next;
    }

    if (entry.next !== null) {
      const nextEntry = this.map.get(entry.next)!;
      nextEntry.prev = entry.prev;
    } else {
      this.tail = entry.prev;
    }
  }

  private evictTail(): void {
    if (this.tail === null) return;
    const sk = this.tail;
    const entry = this.map.get(sk);
    if (entry) {
      this._evictions++;
      this.fireEvict(sk, entry.value);
    }
    this.remove(sk);
  }

  private remove(sk: string): void {
    const entry = this.map.get(sk);
    if (!entry) return;
    this.unlink(sk, entry);
    this.map.delete(sk);
    this.keys.delete(sk);
  }

  private fireEvict(sk: string, value: V): void {
    if (this.onEvict) {
      const key = this.keys.get(sk) as K;
      this.onEvict(key, value);
    }
  }

  // ---- Utilities ----

  private serialize(key: K): string {
    if (typeof key === "string") return key;
    if (typeof key === "number" || typeof key === "bigint") return String(key);
    return JSON.stringify(key);
  }

  private isExpired(entry: Entry<V>): boolean {
    return entry.expiresAt > 0 && Date.now() >= entry.expiresAt;
  }

  private computeExpiry(ttlOverride?: number): number {
    const effective = ttlOverride ?? this.ttl;
    return effective > 0 ? Date.now() + effective : 0;
  }
}
