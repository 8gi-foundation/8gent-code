import { EventEmitter } from "events";

export interface CacheEntry<T = unknown> {
  key: string;
  value: T;
  tags: string[];
  expiresAt: number | null; // ms since epoch, null = no TTL
  dependencies: string[]; // keys that, when invalidated, also invalidate this entry
}

export interface InvalidationEvent {
  key: string;
  reason: "tag" | "pattern" | "dependency" | "ttl" | "manual";
  triggeredBy?: string; // tag, pattern, or parent key
}

export class CacheInvalidator<T = unknown> extends EventEmitter {
  private store = new Map<string, CacheEntry<T>>();

  // -- Write --

  set(
    key: string,
    value: T,
    options: { tags?: string[]; ttlMs?: number; dependencies?: string[] } = {}
  ): void {
    const { tags = [], ttlMs, dependencies = [] } = options;
    const expiresAt = ttlMs != null ? Date.now() + ttlMs : null;
    this.store.set(key, { key, value, tags, expiresAt, dependencies });
  }

  // -- Read --

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.evict(key, "ttl");
      return undefined;
    }
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  // -- Invalidation --

  /** Invalidate a single key and all entries that depend on it. */
  invalidate(key: string): number {
    return this.evict(key, "manual");
  }

  /** Invalidate all entries matching any of the given tags. */
  invalidateByTag(...tags: string[]): number {
    const tagSet = new Set(tags);
    const targets = [...this.store.values()].filter((e) =>
      e.tags.some((t) => tagSet.has(t))
    );
    let count = 0;
    for (const entry of targets) {
      count += this.evict(entry.key, "tag", tags.join(","));
    }
    return count;
  }

  /** Invalidate all entries whose key matches a regex or glob-style pattern string. */
  invalidateByPattern(pattern: string | RegExp): number {
    const re =
      pattern instanceof RegExp
        ? pattern
        : new RegExp(
            "^" +
              pattern
                .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                .replace(/\*/g, ".*")
                .replace(/\?/g, ".") +
              "$"
          );
    const targets = [...this.store.keys()].filter((k) => re.test(k));
    let count = 0;
    for (const key of targets) {
      count += this.evict(key, "pattern", String(pattern));
    }
    return count;
  }

  /** Purge all TTL-expired entries. Returns the number removed. */
  purgeExpired(): number {
    let count = 0;
    for (const entry of [...this.store.values()]) {
      if (this.isExpired(entry)) count += this.evict(entry.key, "ttl");
    }
    return count;
  }

  /** Remove every entry. */
  flush(): number {
    const count = this.store.size;
    for (const key of [...this.store.keys()]) this.evict(key, "manual");
    return count;
  }

  // -- Introspection --

  keys(): string[] {
    return [...this.store.keys()];
  }

  size(): number {
    return this.store.size;
  }

  getEntry(key: string): CacheEntry<T> | undefined {
    return this.store.get(key);
  }

  // -- Internals --

  private isExpired(entry: CacheEntry<T>): boolean {
    return entry.expiresAt !== null && Date.now() > entry.expiresAt;
  }

  /** Remove a key, cascade to dependents, emit event. Returns 1 if removed, 0 if already gone. */
  private evict(
    key: string,
    reason: InvalidationEvent["reason"],
    triggeredBy?: string
  ): number {
    if (!this.store.has(key)) return 0;
    this.store.delete(key);
    const event: InvalidationEvent = { key, reason, triggeredBy };
    this.emit("invalidated", event);
    // cascade: invalidate entries that list this key as a dependency
    for (const entry of [...this.store.values()]) {
      if (entry.dependencies.includes(key)) {
        this.evict(entry.key, "dependency", key);
      }
    }
    return 1;
  }
}
