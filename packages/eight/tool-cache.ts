/**
 * 8gent Code - Tool Result Cache
 *
 * Caches deterministic tool results by args hash.
 * - TTL is configurable per tool type.
 * - Write-category tools (write_file, run_command, etc.) immediately invalidate
 *   all read-category cache entries to prevent stale results.
 * - LRU eviction when the entry count exceeds maxEntries.
 * - Zero runtime dependencies. Uses only Bun/Node built-ins.
 */

import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolCategory = "read" | "write" | "network" | "deterministic";

export interface CacheEntry {
  key: string;
  result: unknown;
  createdAt: number;
  expiresAt: number;
  toolName: string;
  hits: number;
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
  invalidations: number;
}

// ---------------------------------------------------------------------------
// TTL defaults (milliseconds) per tool category
// ---------------------------------------------------------------------------

const DEFAULT_TTL: Record<ToolCategory, number> = {
  deterministic: 60 * 60 * 1000,  // 1 hour  - pure functions, env-independent
  read:          30 * 1000,        // 30 s    - filesystem reads can change
  network:       5 * 60 * 1000,    // 5 min   - HTTP responses
  write:         0,                // 0 = never cache write operations
};

// ---------------------------------------------------------------------------
// Tool -> category mapping
// ---------------------------------------------------------------------------

const WRITE_TOOLS = new Set([
  "write_file",
  "create_file",
  "edit_file",
  "delete_file",
  "run_command",
  "bash",
  "git_commit",
  "git_push",
  "insert_cell",
  "edit_cell",
  "delete_cell",
]);

const NETWORK_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "browser_open",
  "browser_task",
  "browser_screenshot",
]);

const DETERMINISTIC_TOOLS = new Set([
  "parse_ast",
  "get_file_outline",
  "get_symbol",
  "search_symbols",
  "list_repos",
]);

function categorize(toolName: string): ToolCategory {
  if (WRITE_TOOLS.has(toolName)) return "write";
  if (NETWORK_TOOLS.has(toolName)) return "network";
  if (DETERMINISTIC_TOOLS.has(toolName)) return "deterministic";
  return "read";
}

// ---------------------------------------------------------------------------
// ToolCache
// ---------------------------------------------------------------------------

export interface ToolCacheOptions {
  /** Max number of entries before LRU eviction. Default: 512. */
  maxEntries?: number;
  /** Override TTL (ms) per tool category. */
  ttl?: Partial<Record<ToolCategory, number>>;
  /** Override TTL (ms) per individual tool name. Takes precedence over category TTL. */
  toolTtl?: Record<string, number>;
}

export class ToolCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttl: Record<ToolCategory, number>;
  private readonly toolTtl: Record<string, number>;

  private totalHits = 0;
  private totalMisses = 0;
  private totalEvictions = 0;
  private totalInvalidations = 0;

  constructor(options: ToolCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 512;
    this.ttl = { ...DEFAULT_TTL, ...(options.ttl ?? {}) };
    this.toolTtl = options.toolTtl ?? {};
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Return a cached result for (toolName, args) if one exists and has not
   * expired. Returns undefined on a miss.
   */
  get(toolName: string, args: unknown): unknown | undefined {
    const key = this.buildKey(toolName, args);
    const entry = this.cache.get(key);

    if (!entry) {
      this.totalMisses++;
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.totalMisses++;
      return undefined;
    }

    entry.hits++;
    this.totalHits++;

    // Move to end of Map (LRU - most recently used at tail)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.result;
  }

  /**
   * Store a tool result. Write-category tools trigger read invalidation and
   * are not themselves cached.
   */
  set(toolName: string, args: unknown, result: unknown): void {
    const category = categorize(toolName);

    if (category === "write") {
      this.invalidateReads();
      return;
    }

    const ttlMs = this.resolveTtl(toolName, category);
    if (ttlMs === 0) return;

    const key = this.buildKey(toolName, args);
    const now = Date.now();

    const entry: CacheEntry = {
      key,
      result,
      createdAt: now,
      expiresAt: now + ttlMs,
      toolName,
      hits: 0,
    };

    if (!this.cache.has(key) && this.cache.size >= this.maxEntries) {
      this.evictLRU();
    }

    this.cache.set(key, entry);
  }

  /** Explicitly invalidate all entries for a given tool name. */
  invalidateTool(toolName: string): number {
    let count = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (entry.toolName === toolName) {
        this.cache.delete(key);
        count++;
      }
    }
    this.totalInvalidations += count;
    return count;
  }

  /** Invalidate a specific (toolName, args) entry. */
  invalidateEntry(toolName: string, args: unknown): boolean {
    const key = this.buildKey(toolName, args);
    const existed = this.cache.has(key);
    if (existed) {
      this.cache.delete(key);
      this.totalInvalidations++;
    }
    return existed;
  }

  /**
   * Remove all expired entries.
   * Returns the number of entries removed.
   */
  purgeExpired(): number {
    const now = Date.now();
    let count = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /** Flush everything. */
  clear(): void {
    this.cache.clear();
  }

  /** Current cache statistics. */
  stats(): CacheStats {
    return {
      size: this.cache.size,
      hits: this.totalHits,
      misses: this.totalMisses,
      evictions: this.totalEvictions,
      invalidations: this.totalInvalidations,
    };
  }

  /** Hit rate as 0-1. Returns 0 if no lookups yet. */
  hitRate(): number {
    const total = this.totalHits + this.totalMisses;
    return total === 0 ? 0 : this.totalHits / total;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildKey(toolName: string, args: unknown): string {
    const argsJson = JSON.stringify(args, Object.keys(args as object ?? {}).sort());
    return createHash("sha256")
      .update(toolName)
      .update("\0")
      .update(argsJson)
      .digest("hex");
  }

  private resolveTtl(toolName: string, category: ToolCategory): number {
    if (toolName in this.toolTtl) return this.toolTtl[toolName];
    return this.ttl[category];
  }

  /** Invalidate all read-category entries on write. */
  private invalidateReads(): void {
    let count = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (categorize(entry.toolName) === "read") {
        this.cache.delete(key);
        count++;
      }
    }
    this.totalInvalidations += count;
  }

  /** Evict the least recently used entry (head of Map). */
  private evictLRU(): void {
    const firstKey = this.cache.keys().next().value;
    if (firstKey !== undefined) {
      this.cache.delete(firstKey);
      this.totalEvictions++;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton helpers
// ---------------------------------------------------------------------------

let _sharedCache: ToolCache | undefined;

/** Return the process-wide shared cache, creating it on first call. */
export function getToolCache(options?: ToolCacheOptions): ToolCache {
  if (!_sharedCache) {
    _sharedCache = new ToolCache(options);
  }
  return _sharedCache;
}

/** Reset the shared cache (useful in tests). */
export function resetToolCache(): void {
  _sharedCache = undefined;
}
