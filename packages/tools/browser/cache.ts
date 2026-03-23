/**
 * 8gent Browser - Disk Cache
 *
 * SHA-256 keyed, TTL-aware, 100MB-capped page cache.
 * Stored in ~/.8gent/browser-cache/
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CACHE_DIR = join(process.env.EIGHT_DATA_DIR || join(homedir(), ".8gent"), "browser-cache");
const TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CACHE_BYTES = 100 * 1024 * 1024; // 100 MB

interface CacheEntry<T> {
  ts: number;
  data: T;
}

function ensureDir() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function keyFor(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

function cachePath(key: string): string {
  return join(CACHE_DIR, `${key}.json`);
}

export function cacheGet<T>(url: string): T | null {
  ensureDir();
  const p = cachePath(keyFor(url));
  if (!existsSync(p)) return null;
  try {
    const entry: CacheEntry<T> = JSON.parse(readFileSync(p, "utf8"));
    if (Date.now() - entry.ts > TTL_MS) {
      unlinkSync(p);
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

export function cacheSet<T>(url: string, data: T): void {
  ensureDir();
  evictIfNeeded();
  const entry: CacheEntry<T> = { ts: Date.now(), data };
  writeFileSync(cachePath(keyFor(url)), JSON.stringify(entry), "utf8");
}

/** Best-effort LRU eviction when over MAX_CACHE_BYTES */
function evictIfNeeded(): void {
  try {
    const files = readdirSync(CACHE_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        const p = join(CACHE_DIR, f);
        const s = statSync(p);
        return { p, size: s.size, mtime: s.mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime); // oldest first

    let total = files.reduce((sum, f) => sum + f.size, 0);
    for (const f of files) {
      if (total <= MAX_CACHE_BYTES) break;
      unlinkSync(f.p);
      total -= f.size;
    }
  } catch {
    // non-fatal
  }
}
