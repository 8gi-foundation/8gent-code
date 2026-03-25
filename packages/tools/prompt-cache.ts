/**
 * prompt-cache.ts
 * Caches prompt-response pairs with TTL expiry, similarity-based hits, and LRU eviction.
 * No external dependencies.
 */

export interface CacheEntry {
  prompt: string;
  response: string;
  tokens?: number;
  createdAt: number;
  lastAccessedAt: number;
  hits: number;
}

export interface CacheStats {
  size: number;
  capacity: number;
  hits: number;
  misses: number;
  evictions: number;
  hitRate: number;
}

export interface PromptCacheOptions {
  capacity?: number;
  ttlMs?: number;
  similarityThreshold?: number;
}

const DEFAULT_CAPACITY = 200;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SIMILARITY = 0.92;

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function bigrams(text: string): Map<string, number> {
  const map = new Map<string, number>();
  const t = normalize(text);
  for (let i = 0; i < t.length - 1; i++) {
    const bg = t.slice(i, i + 2);
    map.set(bg, (map.get(bg) ?? 0) + 1);
  }
  return map;
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const aMap = bigrams(a);
  const bMap = bigrams(b);
  if (aMap.size === 0 || bMap.size === 0) return 0;
  let intersection = 0;
  for (const [bg, count] of aMap) {
    const bCount = bMap.get(bg) ?? 0;
    intersection += Math.min(count, bCount);
  }
  const aTotal = [...aMap.values()].reduce((s, v) => s + v, 0);
  const bTotal = [...bMap.values()].reduce((s, v) => s + v, 0);
  return (2 * intersection) / (aTotal + bTotal);
}

export class PromptCache {
  private store: Map<string, CacheEntry>;
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly similarityThreshold: number;

  private totalHits = 0;
  private totalMisses = 0;
  private totalEvictions = 0;

  constructor(options: PromptCacheOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.similarityThreshold = options.similarityThreshold ?? DEFAULT_SIMILARITY;
    this.store = new Map();
  }

  get(prompt: string): string | null {
    this.evictExpired();
    const now = Date.now();
    const exact = this.store.get(prompt);
    if (exact) {
      exact.lastAccessedAt = now;
      exact.hits++;
      this.totalHits++;
      this.store.delete(prompt);
      this.store.set(prompt, exact);
      return exact.response;
    }
    if (this.similarityThreshold < 1) {
      let bestKey: string | null = null;
      let bestScore = 0;
      for (const [key] of this.store) {
        const score = similarity(prompt, key);
        if (score > bestScore) {
          bestScore = score;
          bestKey = key;
        }
      }
      if (bestKey !== null && bestScore >= this.similarityThreshold) {
        const entry = this.store.get(bestKey)!;
        entry.lastAccessedAt = now;
        entry.hits++;
        this.totalHits++;
        this.store.delete(bestKey);
        this.store.set(bestKey, entry);
        return entry.response;
      }
    }
    this.totalMisses++;
    return null;
  }

  set(prompt: string, response: string, tokens?: number): void {
    this.evictExpired();
    if (!this.store.has(prompt) && this.store.size >= this.capacity) {
      const lruKey = this.store.keys().next().value;
      if (lruKey !== undefined) {
        this.store.delete(lruKey);
        this.totalEvictions++;
      }
    }
    const now = Date.now();
    this.store.set(prompt, { prompt, response, tokens, createdAt: now, lastAccessedAt: now, hits: 0 });
  }

  delete(prompt: string): boolean {
    return this.store.delete(prompt);
  }

  clear(): void {
    this.store.clear();
    this.totalHits = 0;
    this.totalMisses = 0;
    this.totalEvictions = 0;
  }

  stats(): CacheStats {
    this.evictExpired();
    const total = this.totalHits + this.totalMisses;
    return {
      size: this.store.size,
      capacity: this.capacity,
      hits: this.totalHits,
      misses: this.totalMisses,
      evictions: this.totalEvictions,
      hitRate: total === 0 ? 0 : this.totalHits / total,
    };
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now - entry.createdAt > this.ttlMs) {
        this.store.delete(key);
        this.totalEvictions++;
      }
    }
  }
}
