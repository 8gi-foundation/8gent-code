/**
 * Cache tests per spec §8.3 invariants:
 *   - TTL 2s default
 *   - 16-frame LRU cap
 *   - region-keyed
 *   - LRU bump on access
 *   - manual + predicate invalidation
 */

import { describe, expect, it } from "bun:test";
import { AnnotationCache, annotationKey } from "./cache.js";
import type { AnnotatedFrame } from "./types.js";

function fakeFrame(id: string, displayId = 1): AnnotatedFrame {
	return {
		id,
		path: `/tmp/${id}.png`,
		width: 100,
		height: 100,
		displayId,
		capturedAt: 0,
		scale: 2,
		platform: "darwin",
		elements: [],
	};
}

describe("annotationKey", () => {
	it("encodes frame, display, and region", () => {
		expect(annotationKey("f1", 1)).toBe("f1|1|*");
		expect(annotationKey("f1", 1, { x: 0, y: 0, width: 50, height: 50 })).toBe("f1|1|0,0,50,50");
	});
});

describe("AnnotationCache", () => {
	it("returns undefined on miss", () => {
		const c = new AnnotationCache();
		expect(c.get("missing")).toBeUndefined();
	});

	it("stores and retrieves", () => {
		const c = new AnnotationCache();
		const f = fakeFrame("f1");
		c.set("k", f);
		expect(c.get("k")).toBe(f);
	});

	it("expires entries past TTL", () => {
		let now = 1000;
		const c = new AnnotationCache({ ttlMs: 100, now: () => now });
		c.set("k", fakeFrame("f1"));
		now = 1050;
		expect(c.get("k")).toBeDefined();
		now = 1101;
		expect(c.get("k")).toBeUndefined();
	});

	it("evicts oldest when over cap", () => {
		const c = new AnnotationCache({ maxFrames: 3 });
		c.set("a", fakeFrame("a"));
		c.set("b", fakeFrame("b"));
		c.set("c", fakeFrame("c"));
		c.set("d", fakeFrame("d"));
		expect(c.size()).toBe(3);
		expect(c.get("a")).toBeUndefined();
		expect(c.get("d")).toBeDefined();
	});

	it("LRU bumps on access", () => {
		const c = new AnnotationCache({ maxFrames: 3 });
		c.set("a", fakeFrame("a"));
		c.set("b", fakeFrame("b"));
		c.set("c", fakeFrame("c"));
		// access "a" -> moves it to MRU
		c.get("a");
		c.set("d", fakeFrame("d"));
		// "b" should now be the oldest -> evicted
		expect(c.get("b")).toBeUndefined();
		expect(c.get("a")).toBeDefined();
	});

	it("invalidateMatching drops by predicate", () => {
		const c = new AnnotationCache();
		c.set("d1-a", fakeFrame("a", 1));
		c.set("d1-b", fakeFrame("b", 1));
		c.set("d2-a", fakeFrame("a", 2));
		const dropped = c.invalidateMatching((_k, v) => v.displayId === 1);
		expect(dropped).toBe(2);
		expect(c.size()).toBe(1);
		expect(c.get("d2-a")).toBeDefined();
	});
});
