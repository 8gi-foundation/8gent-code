import type { BenchmarkDefinition } from "../../types";

export const featureImplementationBenchmarks: BenchmarkDefinition[] = [
  {
    id: "FI001",
    category: "feature-implementation",
    title: "LRU Cache with TTL and Stats",
    difficulty: "hard",
    prompt: `Implement an LRU cache with TTL (time-to-live) expiration and usage statistics.

\`\`\`typescript
interface CacheOptions {
  maxSize: number;
  defaultTTL: number; // milliseconds
}

interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
}

class LRUCache<K, V> {
  constructor(options: CacheOptions) { /* implement */ }
  get(key: K): V | undefined { /* implement */ }
  set(key: K, value: V, ttl?: number): void { /* implement */ }
  delete(key: K): boolean { /* implement */ }
  has(key: K): boolean { /* implement */ }
  clear(): void { /* implement */ }
  stats(): CacheStats { /* implement */ }
}
\`\`\`

Requirements:
1. get() returns cached value and promotes to most-recently-used. Returns undefined and counts a miss if not found or expired.
2. set() adds/updates entry. If cache exceeds maxSize, evict least-recently-used entry first.
3. TTL: entries expire after their TTL (per-entry ttl param or defaultTTL). Expired entries return undefined on get().
4. stats() returns { hits, misses, evictions, size } — hits/misses from get(), evictions from LRU eviction only.
5. clear() removes all entries and resets stats to zero.
6. delete() removes a specific entry, returns true if it existed.

Provide the full class implementation as a single code block.`,
    keywords: ["LRU", "cache", "Map", "delete", "set", "get", "evict", "TTL", "expire", "stats", "hits", "misses", "size"],
    keywordThreshold: 7,
    testExecution: true,
    testFile: "autoresearch/tests/FI001-caching.test.ts",
    timeoutMs: 15000,
  },
];
