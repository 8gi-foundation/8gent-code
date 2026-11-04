/**
 * embedder-eval.ts - recall@5 and MRR@5 over the paraphrase set, per embedder.
 *
 * Run:  bun benchmarks/memory/embedder-eval.ts [fts] [gemma] [ollama]
 *   fts     word search only (what memory does with no embedder)
 *   gemma   EmbeddingGemma 2 via llama-server on 127.0.0.1 (needs `8gent memory embedder enable`)
 *   ollama  nomic-embed-text via a local Ollama
 * With no arguments it runs every mode it can reach and says which it skipped.
 * Everything stays on loopback. Stores are :memory: and are never written to disk.
 */

import { LlamaCppEmbeddingProvider, OllamaEmbeddingProvider, type EmbeddingProvider } from "../../packages/memory/embeddings.js";
import { EMBEDDER, ensureEmbedderServer, readEmbedderConfig } from "../../packages/memory/embedder-setup.js";
import { MemoryStore } from "../../packages/memory/store.js";
import type { SemanticMemory } from "../../packages/memory/types.js";
import { PARAPHRASE_PAIRS } from "./paraphrase-set.js";

const K = 5;

function buildCorpus(at: number): SemanticMemory[] {
	return PARAPHRASE_PAIRS.map((p) => ({
		id: p.id,
		type: "semantic",
		category: "fact",
		key: p.key,
		value: p.value,
		confidence: 1,
		evidenceCount: 1,
		tags: [],
		relatedKeys: [],
		learnedAt: at,
		lastConfirmed: at,
		scope: "project",
		importance: 0.5,
		decayFactor: 1,
		accessCount: 0,
		lastAccessed: 0,
		createdAt: at,
		updatedAt: at,
		version: 1,
		source: "user_explicit",
	}));
}

export interface EvalResult {
	mode: string;
	n: number;
	recallAt5: number;
	mrr: number;
	p50QueryMs: number;
}

export async function evaluate(mode: string, provider: EmbeddingProvider | null): Promise<EvalResult> {
	const store = new MemoryStore(":memory:");
	store.writeBatch(buildCorpus(Date.now()));
	if (provider) {
		store.setEmbeddingProvider(provider);
		await store.reembedStale();
	}
	let hits = 0;
	let rr = 0;
	const times: number[] = [];
	for (const p of PARAPHRASE_PAIRS) {
		const t0 = performance.now();
		const results = await store.recall(p.query, { limit: K });
		times.push(performance.now() - t0);
		const rank = results.findIndex((r) => r.memory.id === p.id) + 1;
		if (rank > 0) {
			hits++;
			rr += 1 / rank;
		}
	}
	store.close();
	times.sort((a, b) => a - b);
	const n = PARAPHRASE_PAIRS.length;
	return { mode, n, recallAt5: hits / n, mrr: rr / n, p50QueryMs: times[Math.floor(n / 2)] };
}

async function main() {
	const want = new Set(process.argv.slice(2));
	const all = want.size === 0;
	const out: EvalResult[] = [];
	if (all || want.has("fts")) out.push(await evaluate("fts-only", null));
	if (all || want.has("ollama")) {
		const o = new OllamaEmbeddingProvider();
		if (await o.checkAvailability()) out.push(await evaluate("nomic-embed-text", o));
		else console.log("skipped: ollama has no nomic-embed-text");
	}
	if (all || want.has("gemma")) {
		const cfg = readEmbedderConfig();
		const base = cfg ? await ensureEmbedderServer(cfg) : null;
		const g = base ? new LlamaCppEmbeddingProvider(base) : null;
		if (g && (await g.checkAvailability())) out.push(await evaluate(EMBEDDER.id, g));
		else console.log("skipped: embeddinggemma-2 is not enabled or llama-server is not running");
	}
	for (const r of out) {
		console.log(
			`${r.mode.padEnd(18)} n=${r.n} recall@${K}=${r.recallAt5.toFixed(3)} MRR@${K}=${r.mrr.toFixed(3)} p50 recall latency=${r.p50QueryMs.toFixed(1)}ms`,
		);
	}
}

if (import.meta.main) await main();
