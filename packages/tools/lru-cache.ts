/**
 * 8gent Code - Canonical LRU Cache
 *
 * One Map-based LRU cache for the whole codebase. Re-inserts on get so the
 * most recently used entry is always last in insertion order, and the least
 * recently used entry is always first (and therefore first to be evicted).
 *
 * Optional per-entry TTL, checked lazily on get/has (no timers). The clock is
 * injectable so tests can control time deterministically.
 *
 * No external dependencies.
 */

export interface LruCacheOptions {
	/** Maximum number of entries before the least recently used one is evicted. Must be >= 1. */
	maxEntries: number;
	/** Injectable clock returning milliseconds. Defaults to Date.now. */
	now?: () => number;
}

interface LruEntry<V> {
	value: V;
	/** Absolute expiry time in ms, or undefined for no TTL. */
	expiresAt?: number;
}

export class LruCache<K, V> {
	private map = new Map<K, LruEntry<V>>();
	private readonly maxEntries: number;
	private readonly now: () => number;

	constructor(options: LruCacheOptions) {
		if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
			throw new RangeError(`maxEntries must be an integer >= 1, got ${options.maxEntries}`);
		}
		this.maxEntries = options.maxEntries;
		this.now = options.now ?? Date.now;
	}

	/**
	 * Insert or update an entry, marking it most recently used.
	 * With ttlMs, the entry expires ttlMs milliseconds from now (a ttlMs of 0
	 * expires immediately). Without ttlMs, the entry never expires.
	 * Evicts the least recently used entry when capacity is exceeded.
	 */
	set(key: K, value: V, ttlMs?: number): void {
		if (this.map.has(key)) {
			this.map.delete(key);
		} else if (this.map.size >= this.maxEntries) {
			const oldest = this.map.keys().next();
			if (!oldest.done) this.map.delete(oldest.value);
		}
		const expiresAt = ttlMs === undefined ? undefined : this.now() + ttlMs;
		this.map.set(key, { value, expiresAt });
	}

	/**
	 * Return the value for key, promoting it to most recently used.
	 * Returns undefined for missing or expired entries (expired entries are
	 * removed lazily here).
	 */
	get(key: K): V | undefined {
		const entry = this.map.get(key);
		if (entry === undefined) return undefined;
		if (this.isExpired(entry)) {
			this.map.delete(key);
			return undefined;
		}
		// LRU: re-insert to move to the most-recently-used position.
		this.map.delete(key);
		this.map.set(key, entry);
		return entry.value;
	}

	/**
	 * Return true if key is present and not expired. Does NOT promote the
	 * entry (checking is not using). Expired entries are removed lazily here.
	 */
	has(key: K): boolean {
		const entry = this.map.get(key);
		if (entry === undefined) return false;
		if (this.isExpired(entry)) {
			this.map.delete(key);
			return false;
		}
		return true;
	}

	/** Remove an entry. Returns true if it existed. */
	delete(key: K): boolean {
		return this.map.delete(key);
	}

	/** Remove all entries. */
	clear(): void {
		this.map.clear();
	}

	/**
	 * Number of stored entries. Expiry is lazy, so entries whose TTL has
	 * passed still count until a get/has observes them.
	 */
	get size(): number {
		return this.map.size;
	}

	/**
	 * Iterate [key, value] pairs from least to most recently used, skipping
	 * expired entries. Does not promote and does not mutate the cache, so
	 * deleting entries while iterating is safe (Map iterator semantics).
	 */
	*entries(): IterableIterator<[K, V]> {
		for (const [key, entry] of this.map) {
			if (this.isExpired(entry)) continue;
			yield [key, entry.value];
		}
	}

	/** Iterate keys from least to most recently used, skipping expired entries. */
	*keys(): IterableIterator<K> {
		for (const [key] of this.entries()) yield key;
	}

	private isExpired(entry: LruEntry<V>): boolean {
		return entry.expiresAt !== undefined && this.now() >= entry.expiresAt;
	}
}
