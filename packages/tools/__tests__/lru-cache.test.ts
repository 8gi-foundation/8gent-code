/**
 * Behavior tests for the canonical LruCache (packages/tools/lru-cache.ts).
 *
 * Time is controlled via the injected now() clock - no setTimeout anywhere,
 * so every test is deterministic.
 */

import { describe, expect, test } from "bun:test";
import { LruCache } from "../lru-cache";

/** Manual clock for deterministic TTL tests. */
function makeClock(start = 0) {
	let t = start;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
	};
}

describe("lru-cache", () => {
	describe("set/get basics", () => {
		test("set then get returns the value; missing keys return undefined", () => {
			const cache = new LruCache<string, number>({ maxEntries: 10 });
			cache.set("a", 1);
			expect(cache.get("a")).toBe(1);
			expect(cache.get("missing")).toBeUndefined();
		});

		test("set on an existing key overwrites the value without growing size", () => {
			const cache = new LruCache<string, number>({ maxEntries: 10 });
			cache.set("a", 1);
			cache.set("a", 2);
			expect(cache.get("a")).toBe(2);
			expect(cache.size).toBe(1);
		});

		test("constructor rejects invalid maxEntries", () => {
			expect(() => new LruCache({ maxEntries: 0 })).toThrow(RangeError);
			expect(() => new LruCache({ maxEntries: -1 })).toThrow(RangeError);
			expect(() => new LruCache({ maxEntries: 1.5 })).toThrow(RangeError);
		});
	});

	describe("delete and clear", () => {
		test("delete removes a single entry and reports whether it existed", () => {
			const cache = new LruCache<string, number>({ maxEntries: 10 });
			cache.set("a", 1);
			cache.set("b", 2);
			expect(cache.delete("a")).toBe(true);
			expect(cache.delete("a")).toBe(false);
			expect(cache.get("a")).toBeUndefined();
			expect(cache.get("b")).toBe(2);
			expect(cache.size).toBe(1);
		});

		test("clear empties the cache", () => {
			const cache = new LruCache<string, number>({ maxEntries: 10 });
			cache.set("a", 1);
			cache.set("b", 2);
			cache.clear();
			expect(cache.size).toBe(0);
			expect(cache.get("a")).toBeUndefined();
			expect(cache.has("b")).toBe(false);
		});
	});

	describe("LRU eviction order", () => {
		test("evicts the least recently set entry when capacity is exceeded", () => {
			const cache = new LruCache<string, number>({ maxEntries: 3 });
			cache.set("a", 1);
			cache.set("b", 2);
			cache.set("c", 3);
			cache.set("d", 4); // evicts a
			expect(cache.has("a")).toBe(false);
			expect(cache.get("b")).toBe(2);
			expect(cache.get("c")).toBe(3);
			expect(cache.get("d")).toBe(4);
			expect(cache.size).toBe(3);
		});

		test("get promotes an entry so it survives the next eviction", () => {
			const cache = new LruCache<string, number>({ maxEntries: 3 });
			cache.set("a", 1);
			cache.set("b", 2);
			cache.set("c", 3);
			cache.get("a"); // order now: b, c, a
			cache.set("d", 4); // evicts b, not a
			expect(cache.has("a")).toBe(true);
			expect(cache.has("b")).toBe(false);
			expect(cache.has("c")).toBe(true);
			expect(cache.has("d")).toBe(true);
		});

		test("set on an existing key promotes it (update counts as use)", () => {
			const cache = new LruCache<string, number>({ maxEntries: 2 });
			cache.set("a", 1);
			cache.set("b", 2);
			cache.set("a", 10); // order now: b, a
			cache.set("c", 3); // evicts b
			expect(cache.has("b")).toBe(false);
			expect(cache.get("a")).toBe(10);
			expect(cache.get("c")).toBe(3);
		});

		test("has does NOT promote (checking is not using)", () => {
			const cache = new LruCache<string, number>({ maxEntries: 2 });
			cache.set("a", 1);
			cache.set("b", 2);
			cache.has("a"); // must not change the order
			cache.set("c", 3); // evicts a
			expect(cache.has("a")).toBe(false);
			expect(cache.has("b")).toBe(true);
			expect(cache.has("c")).toBe(true);
		});

		test("entries() iterates from least to most recently used", () => {
			const cache = new LruCache<string, number>({ maxEntries: 3 });
			cache.set("a", 1);
			cache.set("b", 2);
			cache.set("c", 3);
			cache.get("a");
			expect([...cache.entries()]).toEqual([
				["b", 2],
				["c", 3],
				["a", 1],
			]);
			expect([...cache.keys()]).toEqual(["b", "c", "a"]);
		});
	});

	describe("TTL expiry (injected clock, lazy eviction)", () => {
		test("get returns the value before expiry and undefined at/after expiry", () => {
			const clock = makeClock();
			const cache = new LruCache<string, number>({ maxEntries: 10, now: clock.now });
			cache.set("a", 1, 100);
			clock.advance(99);
			expect(cache.get("a")).toBe(1);
			clock.advance(1); // t = 100, TTL elapsed
			expect(cache.get("a")).toBeUndefined();
		});

		test("has respects TTL and lazily removes expired entries", () => {
			const clock = makeClock();
			const cache = new LruCache<string, number>({ maxEntries: 10, now: clock.now });
			cache.set("a", 1, 50);
			expect(cache.has("a")).toBe(true);
			clock.advance(50);
			expect(cache.size).toBe(1); // lazy: still counted until observed
			expect(cache.has("a")).toBe(false);
			expect(cache.size).toBe(0); // observation removed it
		});

		test("expiry is lazy: size includes expired entries until get/has observes them", () => {
			const clock = makeClock();
			const cache = new LruCache<string, number>({ maxEntries: 10, now: clock.now });
			cache.set("a", 1, 10);
			cache.set("b", 2, 10);
			cache.set("c", 3); // no TTL
			clock.advance(10);
			expect(cache.size).toBe(3);
			expect(cache.get("a")).toBeUndefined();
			expect(cache.size).toBe(2);
			expect(cache.has("b")).toBe(false);
			expect(cache.size).toBe(1);
			expect(cache.get("c")).toBe(3);
		});

		test("entries without a TTL never expire", () => {
			const clock = makeClock();
			const cache = new LruCache<string, number>({ maxEntries: 10, now: clock.now });
			cache.set("a", 1);
			clock.advance(Number.MAX_SAFE_INTEGER);
			expect(cache.get("a")).toBe(1);
		});

		test("a ttlMs of 0 expires immediately", () => {
			const clock = makeClock();
			const cache = new LruCache<string, number>({ maxEntries: 10, now: clock.now });
			cache.set("a", 1, 0);
			expect(cache.get("a")).toBeUndefined();
		});

		test("re-setting a key resets its TTL", () => {
			const clock = makeClock();
			const cache = new LruCache<string, number>({ maxEntries: 10, now: clock.now });
			cache.set("a", 1, 100);
			clock.advance(90);
			cache.set("a", 1, 100); // fresh TTL from t=90
			clock.advance(90); // t = 180 < 190
			expect(cache.get("a")).toBe(1);
			clock.advance(10); // t = 190
			expect(cache.get("a")).toBeUndefined();
		});

		test("re-setting without a TTL clears a previous TTL", () => {
			const clock = makeClock();
			const cache = new LruCache<string, number>({ maxEntries: 10, now: clock.now });
			cache.set("a", 1, 10);
			cache.set("a", 1);
			clock.advance(1000);
			expect(cache.get("a")).toBe(1);
		});

		test("entries() skips expired entries", () => {
			const clock = makeClock();
			const cache = new LruCache<string, number>({ maxEntries: 10, now: clock.now });
			cache.set("a", 1, 10);
			cache.set("b", 2);
			clock.advance(10);
			expect([...cache.entries()]).toEqual([["b", 2]]);
		});
	});

	describe("size accounting", () => {
		test("size tracks set, duplicate set, delete, eviction, and clear", () => {
			const cache = new LruCache<string, number>({ maxEntries: 2 });
			expect(cache.size).toBe(0);
			cache.set("a", 1);
			expect(cache.size).toBe(1);
			cache.set("a", 2); // overwrite, no growth
			expect(cache.size).toBe(1);
			cache.set("b", 3);
			expect(cache.size).toBe(2);
			cache.set("c", 4); // evicts a, stays at capacity
			expect(cache.size).toBe(2);
			cache.delete("b");
			expect(cache.size).toBe(1);
			cache.clear();
			expect(cache.size).toBe(0);
		});

		test("size never exceeds maxEntries under sustained inserts", () => {
			const cache = new LruCache<number, number>({ maxEntries: 5 });
			for (let i = 0; i < 100; i++) {
				cache.set(i, i);
				expect(cache.size).toBeLessThanOrEqual(5);
			}
			expect(cache.size).toBe(5);
			// the survivors are the 5 most recent inserts
			for (let i = 95; i < 100; i++) expect(cache.get(i)).toBe(i);
			expect(cache.has(94)).toBe(false);
		});
	});

	describe("generics", () => {
		test("works with number keys and array values", () => {
			const cache = new LruCache<number, number[]>({ maxEntries: 3 });
			cache.set(1, [0.1, 0.2]);
			expect(cache.get(1)).toEqual([0.1, 0.2]);
		});

		test("works with object keys (reference identity) and object values", () => {
			const k1 = { id: 1 };
			const k2 = { id: 1 }; // same shape, different reference
			const cache = new LruCache<object, { name: string }>({ maxEntries: 3 });
			cache.set(k1, { name: "one" });
			expect(cache.get(k1)).toEqual({ name: "one" });
			expect(cache.get(k2)).toBeUndefined();
		});

		test("stores falsy values faithfully (0, empty string, null)", () => {
			const cache = new LruCache<string, number | string | null>({ maxEntries: 5 });
			cache.set("zero", 0);
			cache.set("empty", "");
			cache.set("null", null);
			expect(cache.get("zero")).toBe(0);
			expect(cache.get("empty")).toBe("");
			expect(cache.get("null")).toBeNull();
			expect(cache.has("zero")).toBe(true);
		});
	});

	describe("edge cases", () => {
		test("maxEntries of 1 keeps only the most recent entry", () => {
			const cache = new LruCache<string, number>({ maxEntries: 1 });
			cache.set("a", 1);
			cache.set("b", 2);
			expect(cache.has("a")).toBe(false);
			expect(cache.get("b")).toBe(2);
			expect(cache.size).toBe(1);
			cache.set("b", 3); // overwrite at capacity does not evict itself
			expect(cache.get("b")).toBe(3);
			expect(cache.size).toBe(1);
		});

		test("delete during iteration is safe and takes effect", () => {
			const cache = new LruCache<string, number>({ maxEntries: 10 });
			cache.set("a", 1);
			cache.set("b", 2);
			cache.set("c", 3);
			cache.set("d", 4);
			const seen: string[] = [];
			for (const [key] of cache.entries()) {
				seen.push(key);
				if (key === "a") cache.delete("c"); // delete an upcoming entry mid-iteration
				if (key === "b") cache.delete("b"); // delete the current entry mid-iteration
			}
			expect(seen).toEqual(["a", "b", "d"]); // c was removed before being visited
			expect(cache.size).toBe(2);
			expect(cache.has("a")).toBe(true);
			expect(cache.has("b")).toBe(false);
			expect(cache.has("c")).toBe(false);
			expect(cache.has("d")).toBe(true);
		});

		test("clear during iteration stops yielding further entries", () => {
			const cache = new LruCache<string, number>({ maxEntries: 10 });
			cache.set("a", 1);
			cache.set("b", 2);
			cache.set("c", 3);
			const seen: string[] = [];
			for (const [key] of cache.entries()) {
				seen.push(key);
				if (key === "a") cache.clear();
			}
			expect(seen).toEqual(["a"]);
			expect(cache.size).toBe(0);
		});

		test("eviction after promotions targets the true LRU across a mixed workload", () => {
			const cache = new LruCache<string, number>({ maxEntries: 4 });
			cache.set("a", 1);
			cache.set("b", 2);
			cache.set("c", 3);
			cache.set("d", 4);
			cache.get("b");
			cache.get("a"); // order: c, d, b, a
			cache.set("e", 5); // evicts c
			cache.set("f", 6); // evicts d
			expect([...cache.keys()]).toEqual(["b", "a", "e", "f"]);
		});
	});
});
