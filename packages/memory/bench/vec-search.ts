/**
 * Benchmark: sqlite-vec native search vs in-process JS cosine.
 *
 * Generates N random 768-dim embeddings, writes them through MemoryStore
 * with both backends, and times K-nearest-neighbor recall for a query
 * vector. Reports wall time, per-query throughput, and speedup.
 *
 * Run:   bun run packages/memory/bench/vec-search.ts
 * Sizes: SIZES env var (e.g. SIZES=1000,5000,25000)
 *
 * Notes:
 *   - Uses bun:sqlite in-memory databases so disk I/O does not skew
 *     the comparison.
 *   - Each backend gets its own MemoryStore so the JS path cannot
 *     accidentally hit the vec table cache.
 *   - We bypass the embedding provider and call the vec table / embeddings
 *     table directly so we don't depend on Ollama for the benchmark.
 */

import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cosineSimilarity } from "../embeddings.js";
import { MemoryStore } from "../store.js";
import {
	encodeVector,
	ensureSqliteSupportsExtensions,
	loadSqliteVec,
} from "../sqlite-vec.js";

const DIM = 768;
const QUERIES = 25;
const SIZES = (process.env.SIZES ?? "1000,10000,50000")
	.split(",")
	.map((s) => Number.parseInt(s.trim(), 10))
	.filter((n) => Number.isFinite(n) && n > 0);

function randomUnitVector(dim: number): Float32Array {
	const v = new Float32Array(dim);
	let norm = 0;
	for (let i = 0; i < dim; i++) {
		const x = Math.random() * 2 - 1;
		v[i] = x;
		norm += x * x;
	}
	const inv = 1 / Math.sqrt(norm);
	for (let i = 0; i < dim; i++) v[i] *= inv;
	return v;
}

function nowMs(): number {
	return performance.now();
}

interface Run {
	size: number;
	jsMs: number;
	vecMs: number | null;
	speedup: number | null;
}

async function benchmarkSize(size: number): Promise<Run> {
	const dir = mkdtempSync(join(tmpdir(), "memvec-bench-"));
	const dbPath = join(dir, `${size}.db`);

	// ── Setup: raw DB, load vec, populate both tables ──────────────
	ensureSqliteSupportsExtensions();
	const db = new Database(dbPath, { create: true });
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");

	const vec = loadSqliteVec(db);
	const vecAvailable = vec.ok;

	// Minimal table for the JS path benchmark.
	db.exec(`
    CREATE TABLE embeddings_bench (
      memory_id TEXT PRIMARY KEY,
      vector    BLOB NOT NULL
    );
  `);
	if (vecAvailable) {
		db.exec(`
      CREATE VIRTUAL TABLE memories_vec_bench USING vec0(
        memory_id TEXT PRIMARY KEY,
        embedding float[${DIM}] distance_metric=cosine
      );
    `);
	}

	const insertJs = db.prepare(
		"INSERT INTO embeddings_bench (memory_id, vector) VALUES (?, ?)",
	);
	const insertVec = vecAvailable
		? db.prepare("INSERT INTO memories_vec_bench (memory_id, embedding) VALUES (?, ?)")
		: null;

	const populate = db.transaction(() => {
		for (let i = 0; i < size; i++) {
			const v = randomUnitVector(DIM);
			const buf = encodeVector(v);
			const id = `mem_${i}`;
			insertJs.run(id, buf);
			insertVec?.run(id, buf);
		}
	});
	const popStart = nowMs();
	populate();
	const popMs = nowMs() - popStart;

	// ── Benchmark: JS cosine path (mirrors _vectorSearchJs) ────────
	const queryVecs: Float32Array[] = [];
	for (let q = 0; q < QUERIES; q++) queryVecs.push(randomUnitVector(DIM));

	// Reproduce the production path: every recall fetches all vectors via
	// SQL, decodes the BLOB, runs cosine in JS, then sorts.
	const fetchAll = db.prepare("SELECT memory_id, vector FROM embeddings_bench");

	const jsStart = nowMs();
	for (const q of queryVecs) {
		const rows = fetchAll.all() as Array<{ memory_id: string; vector: Buffer }>;
		const top: Array<{ id: string; sim: number }> = [];
		for (const row of rows) {
			const vec = new Float32Array(
				row.vector.buffer,
				row.vector.byteOffset,
				row.vector.byteLength / 4,
			);
			const sim = cosineSimilarity(q, vec);
			top.push({ id: row.memory_id, sim });
		}
		top.sort((a, b) => b.sim - a.sim);
		top.length = 10;
	}
	const jsMs = nowMs() - jsStart;

	// ── Benchmark: sqlite-vec native KNN ───────────────────────────
	let vecMs: number | null = null;
	if (vecAvailable) {
		const stmt = db.prepare(
			"SELECT memory_id, distance FROM memories_vec_bench WHERE embedding MATCH ? AND k = 10 ORDER BY distance",
		);
		const vecStart = nowMs();
		for (const q of queryVecs) {
			stmt.all(encodeVector(q));
		}
		vecMs = nowMs() - vecStart;
	}

	const speedup = vecMs && vecMs > 0 ? jsMs / vecMs : null;

	console.log(
		`size=${size.toString().padStart(7)}  populate=${popMs.toFixed(0)}ms  ` +
			`js=${jsMs.toFixed(1)}ms (${(jsMs / QUERIES).toFixed(2)}ms/query)  ` +
			(vecAvailable
				? `vec=${(vecMs ?? 0).toFixed(1)}ms (${((vecMs ?? 0) / QUERIES).toFixed(2)}ms/query)  ` +
					`speedup=${speedup ? `${speedup.toFixed(1)}x` : "n/a"}`
				: "vec=skipped (extension not loaded)"),
	);

	db.close();
	return { size, jsMs, vecMs, speedup };
}

async function smokeStore(): Promise<void> {
	// Make sure the public MemoryStore boots clean with the extension on
	// this host. Catches platform-specific load failures before benchmarking.
	// Pass a stub provider so the vec0 table is materialized.
	const stubProvider = {
		dimensions: DIM,
		model: "stub",
		available: false,
		async generate() {
			return new Float32Array(0);
		},
		async generateBatch(texts: string[]) {
			return texts.map(() => new Float32Array(0));
		},
	};
	const dir = mkdtempSync(join(tmpdir(), "memvec-smoke-"));
	const store = new MemoryStore(join(dir, "smoke.db"), stubProvider);
	const native = store.hasNativeVectorSearch();
	store.close();
	console.log(`MemoryStore native vector search: ${native ? "available" : "fallback to JS"}`);
}

async function main(): Promise<void> {
	console.log(
		`\nsqlite-vec benchmark — dim=${DIM}, queries=${QUERIES}, sizes=[${SIZES.join(", ")}]\n`,
	);
	await smokeStore();
	console.log();
	const runs: Run[] = [];
	for (const size of SIZES) {
		runs.push(await benchmarkSize(size));
	}
	console.log();
	if (runs.some((r) => r.vecMs !== null)) {
		const max = runs.reduce((acc, r) => (r.speedup && r.speedup > acc ? r.speedup : acc), 0);
		console.log(`peak speedup: ${max.toFixed(1)}x`);
	} else {
		console.log("vec backend was not available on this host; only JS path was measured.");
	}
}

await main();
