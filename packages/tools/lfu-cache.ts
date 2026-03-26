/**
 * A cache that evicts the least frequently used entries.
 * @template K - Type of keys
 * @template V - Type of values
 */
export class LFUCache<K, V> {
  /**
   * Creates an instance of LFUCache.
   * @param capacity - Maximum number of entries in the cache
   */
  constructor(private readonly capacity: number) {
    this.cache = new Map();
    this.lastAccessedCounter = 0;
  }

  private readonly cache: Map<K, { value: V; frequency: number; lastAccessed: number }>;
  private lastAccessedCounter: number;

  /**
   * Retrieves the value associated with the key.
   * @param key - The key to retrieve
   * @returns The value if present, otherwise undefined
   */
  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    entry.frequency += 1;
    entry.lastAccessed = this.lastAccessedCounter++;
    return entry.value;
  }

  /**
   * Adds or updates the value associated with the key.
   * @param key - The key to add/update
   * @param value - The value to store
   */
  set(key: K, value: V): void {
    if (this.cache.size >= this.capacity) {
      this.evict();
    }
    const entry = this.cache.get(key);
    if (entry) {
      entry.value = value;
      entry.frequency += 1;
      entry.lastAccessed = this.lastAccessedCounter++;
    } else {
      this.cache.set(key, { value, frequency: 1, lastAccessed: this.lastAccessedCounter++ });
    }
  }

  private evict(): void {
    let minFrequency = Infinity;
    let oldestKey: K | undefined;
    let oldestLastAccessed = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.frequency < minFrequency) {
        minFrequency = entry.frequency;
        oldestKey = key;
        oldestLastAccessed = entry.lastAccessed;
      } else if (entry.frequency === minFrequency && entry.lastAccessed < oldestLastAccessed) {
        oldestKey = key;
        oldestLastAccessed = entry.lastAccessed;
      }
    }

    if (oldestKey !== undefined) {
      this.cache.delete(oldestKey);
    }
  }
}