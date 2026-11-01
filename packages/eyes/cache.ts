/**
 * Annotation cache per spec §8.3.
 *
 * Bounds:
 *   - TTL 2000 ms (volatile screen state; longer invites stale-locator clicks)
 *   - 16-frame LRU cap (annotated AX trees are 10-200 KB on rich apps)
 *   - Key: (frame.id, displayId, region-hash)
 *   - Auto-invalidated by observe() when diff.similarity < threshold
 *
 * Cache lives inside the backend, never in the registry. Stateless registry
 * is a hard architectural rule.
 */

import type { AnnotatedFrame, Region } from "./types.js";

const DEFAULT_TTL_MS = 2_000;
const DEFAULT_MAX_FRAMES = 16;

export interface AnnotationCacheOpts {
	ttlMs?: number;
	maxFrames?: number;
	now?: () => number; // injectable for tests
}

interface CacheEntry {
	value: AnnotatedFrame;
	insertedAt: number;
}

function regionKey(r?: Region): string {
	if (!r) return "*";
	return `${r.x},${r.y},${r.width},${r.height}`;
}

export function annotationKey(
	frameId: string,
	displayId: number,
	region?: Region,
): string {
	return `${frameId}|${displayId}|${regionKey(region)}`;
}

export class AnnotationCache {
	private readonly ttlMs: number;
	private readonly maxFrames: number;
	private readonly now: () => number;
	// Map preserves insertion order; we re-insert on access for LRU.
	private readonly store = new Map<string, CacheEntry>();

	constructor(opts: AnnotationCacheOpts = {}) {
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
		this.maxFrames = opts.maxFrames ?? DEFAULT_MAX_FRAMES;
		this.now = opts.now ?? Date.now;
	}

	get(key: string): AnnotatedFrame | undefined {
		const entry = this.store.get(key);
		if (!entry) return undefined;
		if (this.now() - entry.insertedAt > this.ttlMs) {
			this.store.delete(key);
			return undefined;
		}
		// LRU bump.
		this.store.delete(key);
		this.store.set(key, entry);
		return entry.value;
	}

	set(key: string, value: AnnotatedFrame): void {
		if (this.store.has(key)) this.store.delete(key);
		this.store.set(key, { value, insertedAt: this.now() });
		while (this.store.size > this.maxFrames) {
			const oldest = this.store.keys().next().value;
			if (oldest === undefined) break;
			this.store.delete(oldest);
		}
	}

	delete(key: string): boolean {
		return this.store.delete(key);
	}

	clear(): void {
		this.store.clear();
	}

	size(): number {
		return this.store.size;
	}

	/**
	 * Drop every entry whose frame matches a predicate. Used by observe() when
	 * a change event invalidates everything for a given displayId.
	 */
	invalidateMatching(predicate: (key: string, value: AnnotatedFrame) => boolean): number {
		let dropped = 0;
		for (const [key, entry] of this.store) {
			if (predicate(key, entry.value)) {
				this.store.delete(key);
				dropped++;
			}
		}
		return dropped;
	}
}
