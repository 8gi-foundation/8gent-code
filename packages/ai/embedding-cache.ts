/**
 * 8gent AI - Embedding Cache
 *
 * In-memory LRU cache for embeddings. Avoids re-computing embeddings
 * for the same text. Flushes to disk on demand.
 *
 * Inspired by: https://huggingface.co/spaces/webml-community/Nemotron-3-Nano-WebGPU
 * (edge inference pattern - compute once, reuse often)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LruCache } from "../tools/lru-cache";

const CACHE_DIR = join(process.env.HOME || "~", ".8gent");
const CACHE_PATH = join(CACHE_DIR, "embedding-cache.json");
const MAX_ENTRIES = 1000;

export class EmbeddingCache {
	private cache: LruCache<string, number[]>;

	constructor() {
		this.cache = new LruCache({ maxEntries: MAX_ENTRIES });
		this._load();
	}

	get(text: string): number[] | null {
		// LruCache.get promotes on hit (re-insert to move to end)
		return this.cache.get(text) ?? null;
	}

	set(text: string, embedding: number[]): void {
		// LruCache evicts the oldest entry when capacity is exceeded
		this.cache.set(text, embedding);
	}

	/** Returns cosine similarity if both texts are cached, otherwise null */
	similarity(a: string, b: string): number | null {
		const ea = this.get(a);
		const eb = this.get(b);
		if (!ea || !eb) return null;
		return cosineSimilarity(ea, eb);
	}

	/** Size of cache */
	get size(): number {
		return this.cache.size;
	}

	/** Flush cache to disk */
	flush(): void {
		if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
		const obj: Record<string, number[]> = {};
		for (const [k, v] of this.cache.entries()) obj[k] = v;
		writeFileSync(CACHE_PATH, JSON.stringify(obj));
	}

	/** Clear all cached entries */
	clear(): void {
		this.cache.clear();
	}

	private _load(): void {
		try {
			if (existsSync(CACHE_PATH)) {
				const raw = JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as Record<string, number[]>;
				for (const [k, v] of Object.entries(raw)) {
					// keep the first MAX_ENTRIES from disk, matching the original loader
					if (this.cache.size < MAX_ENTRIES) this.cache.set(k, v);
				}
			}
		} catch {
			/* start fresh */
		}
	}
}

// ============================================
// Pure math - no deps
// ============================================

export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length || a.length === 0) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}

// Singleton
let _cache: EmbeddingCache | null = null;
export function getEmbeddingCache(): EmbeddingCache {
	if (!_cache) _cache = new EmbeddingCache();
	return _cache;
}
