/**
 * Tests for ToolResultCache.
 *
 * Acceptance criteria from issue #2462:
 *  - tryGet after put returns { hit: true, result } for same inputs
 *  - tryGet returns { hit: false } for different inputs
 *  - Key-reordered JSON treated as same input
 *  - After ttlMs elapses, entry expires (injected clock)
 *  - After maxEntries puts, oldest entry evicted (LRU)
 *  - File-path inputs: changing file mtime invalidates the cache entry
 *  - Cache is OFF for write tools by default (caller passes readonly flag)
 *  - Telemetry: hits/misses surfaced as integers (TokenTracker pattern)
 *  - No global state, instance per session
 *
 * Boardroom amendment (8DO Moira, 2026-05-09):
 *  - Telemetry exposes hits/misses as integers, NOT raw cache-key hashes
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolResultCache } from "../tool-result-cache";

const result = (value: string) => ({ ok: true, value });

describe("ToolResultCache", () => {
	it("returns hit for identical inputs after put", () => {
		const c = new ToolResultCache();
		c.put("read_file", { path: "/x" }, result("a"));
		const got = c.tryGet("read_file", { path: "/x" });
		expect(got.hit).toBe(true);
		if (got.hit) expect(got.result).toEqual(result("a"));
	});

	it("returns miss for different inputs", () => {
		const c = new ToolResultCache();
		c.put("read_file", { path: "/x" }, result("a"));
		const got = c.tryGet("read_file", { path: "/y" });
		expect(got.hit).toBe(false);
	});

	it("treats key-reordered JSON as the same input", () => {
		const c = new ToolResultCache();
		c.put("grep", { pattern: "foo", path: "/x", limit: 10 }, result("a"));
		const got = c.tryGet("grep", { limit: 10, path: "/x", pattern: "foo" });
		expect(got.hit).toBe(true);
	});

	it("treats different tool names as different keys", () => {
		const c = new ToolResultCache();
		c.put("read_file", { path: "/x" }, result("a"));
		const got = c.tryGet("glob", { path: "/x" });
		expect(got.hit).toBe(false);
	});

	it("expires entries after ttlMs (injected clock)", () => {
		let now = 1_000_000;
		const c = new ToolResultCache({ ttlMs: 1000, now: () => now });
		c.put("read_file", { path: "/x" }, result("a"));
		now += 999;
		expect(c.tryGet("read_file", { path: "/x" }).hit).toBe(true);
		now += 2;
		expect(c.tryGet("read_file", { path: "/x" }).hit).toBe(false);
	});

	it("evicts oldest entry past maxEntries (LRU)", () => {
		const c = new ToolResultCache({ maxEntries: 3 });
		c.put("t", { i: 1 }, result("1"));
		c.put("t", { i: 2 }, result("2"));
		c.put("t", { i: 3 }, result("3"));
		c.put("t", { i: 4 }, result("4")); // evicts i:1
		expect(c.tryGet("t", { i: 1 }).hit).toBe(false);
		expect(c.tryGet("t", { i: 2 }).hit).toBe(true);
		expect(c.tryGet("t", { i: 3 }).hit).toBe(true);
		expect(c.tryGet("t", { i: 4 }).hit).toBe(true);
	});

	it("LRU promotes on read so recently-used survives eviction", () => {
		const c = new ToolResultCache({ maxEntries: 3 });
		c.put("t", { i: 1 }, result("1"));
		c.put("t", { i: 2 }, result("2"));
		c.put("t", { i: 3 }, result("3"));
		expect(c.tryGet("t", { i: 1 }).hit).toBe(true); // promote i:1
		c.put("t", { i: 4 }, result("4")); // should evict i:2 (now oldest), not i:1
		expect(c.tryGet("t", { i: 1 }).hit).toBe(true);
		expect(c.tryGet("t", { i: 2 }).hit).toBe(false);
	});

	describe("resource-state validation (file mtime)", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trc-test-"));
		const fileA = path.join(tmpDir, "a.txt");

		beforeAll(() => {
			fs.writeFileSync(fileA, "v1");
		});
		afterAll(() => {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it("invalidates entry when underlying file mtime changes", () => {
			const c = new ToolResultCache();
			c.put("read_file", { path: fileA }, result("v1"));
			expect(c.tryGet("read_file", { path: fileA }).hit).toBe(true);
			// Force mtime forward by 2s; fs resolution can be 1s on some platforms.
			const future = new Date(Date.now() + 2000);
			fs.utimesSync(fileA, future, future);
			expect(c.tryGet("read_file", { path: fileA }).hit).toBe(false);
		});

		it("misses when file no longer exists", () => {
			const c = new ToolResultCache();
			const ghost = path.join(tmpDir, "ghost.txt");
			fs.writeFileSync(ghost, "x");
			c.put("read_file", { path: ghost }, result("x"));
			fs.unlinkSync(ghost);
			expect(c.tryGet("read_file", { path: ghost }).hit).toBe(false);
		});
	});

	it("size reflects entries currently held", () => {
		const c = new ToolResultCache();
		expect(c.size).toBe(0);
		c.put("t", { i: 1 }, result("1"));
		c.put("t", { i: 2 }, result("2"));
		expect(c.size).toBe(2);
	});

	it("telemetry exposes hits and misses as integers (8DO addendum)", () => {
		const c = new ToolResultCache();
		c.tryGet("t", { i: 1 }); // miss
		c.put("t", { i: 1 }, result("1"));
		c.tryGet("t", { i: 1 }); // hit
		c.tryGet("t", { i: 1 }); // hit
		c.tryGet("t", { i: 2 }); // miss
		const stats = c.stats();
		expect(stats.hits).toBe(2);
		expect(stats.misses).toBe(2);
		expect(Number.isInteger(stats.hits)).toBe(true);
		expect(Number.isInteger(stats.misses)).toBe(true);
		// 8DO: must NOT leak cache-key hashes
		expect(Object.keys(stats).sort()).toEqual(["entries", "hits", "misses"].sort());
	});

	it("instances are isolated (no global state)", () => {
		const a = new ToolResultCache();
		const b = new ToolResultCache();
		a.put("t", { i: 1 }, result("a"));
		expect(b.tryGet("t", { i: 1 }).hit).toBe(false);
		expect(b.size).toBe(0);
	});

	it("clear empties the cache and resets stats", () => {
		const c = new ToolResultCache();
		c.put("t", { i: 1 }, result("1"));
		c.tryGet("t", { i: 1 });
		c.clear();
		expect(c.size).toBe(0);
		expect(c.stats()).toEqual({ hits: 0, misses: 0, entries: 0 });
	});
});
