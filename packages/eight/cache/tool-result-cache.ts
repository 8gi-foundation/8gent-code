/**
 * ToolResultCache
 *
 * Per-session LRU cache for read-only tool results.
 *  - Key: sha256(toolName + canonicalJson(input))
 *  - Eviction: LRU at maxEntries (default 500)
 *  - Expiry:   TTL evaluated lazily on tryGet (default 30 min)
 *  - Validity: file-path inputs carry mtime; mtime drift invalidates the entry
 *  - Telemetry: integer hit/miss counters via stats() — no key material leaked
 *
 * Caller is responsible for deciding whether a tool is read-only; this module
 * only stores and validates. Designed to compose with a downstream classifier:
 *
 *     cache.tryGet(name, input) ?? router.classify(name, input) ?? execute()
 *
 * No global state. Instance per session.
 *
 * Concept extracted from StartupHakk/OpenMonoAgent under CleanRoomPort rules;
 * no AGPL source copied. See docs/skills/CleanRoomPort.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";

// ============================================================================
// Public types
// ============================================================================

export type ToolResult = unknown;

export interface ToolResultCacheOptions {
	/** Max entries before LRU eviction. Default 500. */
	maxEntries?: number;
	/** Time-to-live in milliseconds. Default 30 minutes. */
	ttlMs?: number;
	/** Injectable clock for tests. Default `Date.now`. */
	now?: () => number;
}

export type CacheHit = { hit: true; result: ToolResult };
export type CacheMiss = { hit: false };
export type CacheLookup = CacheHit | CacheMiss;

export interface CacheStats {
	hits: number;
	misses: number;
	entries: number;
}

// ============================================================================
// Internals
// ============================================================================

interface Entry {
	result: ToolResult;
	storedAt: number;
	/** Map of file path -> mtimeMs at time of put. Empty when no path inputs. */
	resourceMtimes: Map<string, number>;
}

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

/**
 * Recursively sort object keys so semantically identical inputs hash identically.
 * Arrays preserve order. Primitives pass through.
 */
function canonicalize(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(canonicalize);
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		out[key] = canonicalize((value as Record<string, unknown>)[key]);
	}
	return out;
}

function makeKey(toolName: string, input: unknown): string {
	const h = createHash("sha256");
	h.update(toolName);
	h.update("\0");
	h.update(JSON.stringify(canonicalize(input)));
	return h.digest("hex");
}

/**
 * Walk an input value and collect any string fields that look like file paths
 * the caller cared about. We accept the common shapes used by read-only tools:
 *   { path: "..." }, { paths: ["...","..."] }, { file: "..." }, { files: [] }
 * Nested objects are walked too, but we deliberately do NOT treat every string
 * as a path — we only check fields named path / file / paths / files.
 */
function extractPaths(input: unknown): string[] {
	const out: string[] = [];
	const seen = new WeakSet<object>();
	const visit = (node: unknown): void => {
		if (node === null || typeof node !== "object") return;
		if (seen.has(node as object)) return;
		seen.add(node as object);
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		const obj = node as Record<string, unknown>;
		for (const [key, val] of Object.entries(obj)) {
			if ((key === "path" || key === "file") && typeof val === "string") {
				out.push(val);
			} else if ((key === "paths" || key === "files") && Array.isArray(val)) {
				for (const v of val) if (typeof v === "string") out.push(v);
			} else {
				visit(val);
			}
		}
	};
	visit(input);
	return out;
}

function statMtime(filePath: string): number | null {
	try {
		return fs.statSync(filePath).mtimeMs;
	} catch {
		return null;
	}
}

// ============================================================================
// ToolResultCache
// ============================================================================

export class ToolResultCache {
	private readonly maxEntries: number;
	private readonly ttlMs: number;
	private readonly now: () => number;
	/** Map iteration order is insertion order; we re-insert on read for LRU. */
	private readonly entries = new Map<string, Entry>();
	private hitCount = 0;
	private missCount = 0;

	constructor(opts: ToolResultCacheOptions = {}) {
		this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
		this.now = opts.now ?? Date.now;
	}

	get size(): number {
		return this.entries.size;
	}

	/**
	 * Look up a cached result. Returns { hit: true, result } if a fresh entry
	 * exists and its underlying file resources have not changed.
	 */
	tryGet(toolName: string, input: unknown): CacheLookup {
		const key = makeKey(toolName, input);
		const entry = this.entries.get(key);
		if (!entry) {
			this.missCount += 1;
			return { hit: false };
		}

		// TTL
		if (this.now() - entry.storedAt > this.ttlMs) {
			this.entries.delete(key);
			this.missCount += 1;
			return { hit: false };
		}

		// Resource-state validation
		for (const [filePath, storedMtime] of entry.resourceMtimes) {
			const current = statMtime(filePath);
			if (current === null || current !== storedMtime) {
				this.entries.delete(key);
				this.missCount += 1;
				return { hit: false };
			}
		}

		// LRU promotion: re-insert to move to most-recent end of iteration order.
		this.entries.delete(key);
		this.entries.set(key, entry);
		this.hitCount += 1;
		return { hit: true, result: entry.result };
	}

	/**
	 * Store a tool result. Caller must have already decided the tool is
	 * read-only and thus safe to cache.
	 */
	put(toolName: string, input: unknown, result: ToolResult): void {
		const key = makeKey(toolName, input);
		const resourceMtimes = new Map<string, number>();
		for (const filePath of extractPaths(input)) {
			const m = statMtime(filePath);
			if (m !== null) resourceMtimes.set(filePath, m);
		}
		// If key already exists, delete first so re-insert moves it to the end.
		if (this.entries.has(key)) this.entries.delete(key);
		this.entries.set(key, { result, storedAt: this.now(), resourceMtimes });

		// LRU eviction
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	/** Integer hit/miss/entry counters. Never returns key material. */
	stats(): CacheStats {
		return {
			hits: this.hitCount,
			misses: this.missCount,
			entries: this.entries.size,
		};
	}

	/** Drop all entries and zero the counters. */
	clear(): void {
		this.entries.clear();
		this.hitCount = 0;
		this.missCount = 0;
	}
}
