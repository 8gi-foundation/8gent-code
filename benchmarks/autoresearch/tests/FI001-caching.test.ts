/**
 * FI001 — LRU Cache with TTL and Stats
 *
 * Loads the LLM-generated cache from FIXTURE_PATH env var,
 * then verifies LRU eviction, TTL expiry, and stats tracking.
 */
import { describe, test, expect, beforeEach } from "bun:test";

const fixturePath = process.env.FIXTURE_PATH;
if (!fixturePath) throw new Error("FIXTURE_PATH env var required");

const mod = await import(fixturePath);
const CacheClass = mod.default ?? mod.LRUCache ?? mod.Cache;

if (!CacheClass) {
  throw new Error("Module must export LRUCache, Cache, or default class");
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("FI001: LRU Cache", () => {
  let cache: InstanceType<typeof CacheClass>;

  beforeEach(() => {
    cache = new CacheClass({ maxSize: 3, defaultTTL: 5000 });
  });

  test("basic set and get", () => {
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
  });

  test("get returns undefined for missing key", () => {
    expect(cache.get("nope")).toBeUndefined();
  });

  test("cache hit increments hits counter", () => {
    cache.set("a", 1);
    cache.get("a");
    cache.get("a");
    const s = cache.stats();
    expect(s.hits).toBe(2);
  });

  test("cache miss increments misses counter", () => {
    cache.get("nope");
    cache.get("nope2");
    const s = cache.stats();
    expect(s.misses).toBe(2);
  });

  test("LRU eviction when exceeding maxSize", () => {
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    // a is LRU, adding d should evict a
    cache.set("d", 4);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("d")).toBe(4);
  });

  test("get() promotes to MRU, changing eviction order", () => {
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    // Access a → a is now MRU, b is LRU
    cache.get("a");
    cache.set("d", 4); // should evict b, not a
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
  });

  test("evictions counter tracks LRU evictions", () => {
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4); // evicts a
    cache.set("e", 5); // evicts b
    const s = cache.stats();
    expect(s.evictions).toBe(2);
  });

  test("TTL expiry — entry disappears after TTL", async () => {
    const shortCache = new CacheClass({ maxSize: 10, defaultTTL: 100 });
    shortCache.set("temp", "val");
    expect(shortCache.get("temp")).toBe("val");
    await delay(150);
    expect(shortCache.get("temp")).toBeUndefined();
  });

  test("per-entry TTL overrides default", async () => {
    cache.set("short", "gone", 100); // 100ms TTL
    cache.set("long", "here", 10000); // 10s TTL
    await delay(150);
    expect(cache.get("short")).toBeUndefined();
    expect(cache.get("long")).toBe("here");
  });

  test("delete removes entry and returns true", () => {
    cache.set("a", 1);
    expect(cache.delete("a")).toBe(true);
    expect(cache.get("a")).toBeUndefined();
  });

  test("delete returns false for missing key", () => {
    expect(cache.delete("nope")).toBe(false);
  });

  test("has() returns correct boolean", () => {
    cache.set("a", 1);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("nope")).toBe(false);
  });

  test("clear removes all entries and resets stats", () => {
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // hit
    cache.get("nope"); // miss
    cache.clear();
    const s = cache.stats();
    expect(s.size).toBe(0);
    expect(s.hits).toBe(0);
    expect(s.misses).toBe(0);
    expect(s.evictions).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  test("stats.size reflects current entry count", () => {
    expect(cache.stats().size).toBe(0);
    cache.set("a", 1);
    expect(cache.stats().size).toBe(1);
    cache.set("b", 2);
    expect(cache.stats().size).toBe(2);
    cache.delete("a");
    expect(cache.stats().size).toBe(1);
  });
});
