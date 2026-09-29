/**
 * Semantic locate (M3b): nearest symbols by meaning, for queries that
 * describe a behaviour without the words its code uses.
 *
 * Each function, class, interface, type and method is embedded once as its
 * signature plus its path ("function f(a: string) src/a.ts"), with the
 * memory package's nomic client (nomic-embed-text through Ollama,
 * packages/memory/embeddings.ts). nomic's task prefixes are used:
 * "search_document: " for symbols, "search_query: " for the query. A query is
 * answered by cosine similarity over every vector (brute force; no vector
 * database), at most two rows per file.
 *
 * Built lazily: the first semantic query starts the build and gets
 * status "building" (locate then answers with hybrid and says so). Vectors
 * are stored beside the AST index cache (index-cache.ts), keyed by a hash of
 * the text embedded, so a restart embeds nothing again and a changed file
 * re-embeds only signatures whose text changed. When the embedding model is
 * not available the status is "unavailable" and locate answers with hybrid.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type EmbeddingProvider, OllamaEmbeddingProvider } from "../memory/embeddings";
import type { Symbol } from "../types";
import {
	getFileOutline,
	getFileTree,
	getRepoCacheRoot,
	getRepoStats,
	getSymbol,
	indexGeneration,
} from "./index";
import { repoCacheDir } from "./index-cache";

/** Symbol kinds that get a vector. Constants and variables are most of the index and rarely a concept. */
export const SEMANTIC_KINDS: ReadonlySet<string> = new Set([
	"function",
	"class",
	"interface",
	"type",
	"method",
]);

const DOC_PREFIX = "search_document: ";
const QUERY_PREFIX = "search_query: ";
/** Signature characters kept per symbol; long parameter lists add noise, not meaning. */
const SIGNATURE_MAX = 240;
/** Texts sent to the embedder per batch. */
const BATCH = 64;
/** New vectors between saves, so an interrupted build resumes where it stopped. */
const SAVE_EVERY = 2048;
/** After a failed or unavailable build, searches report unavailable for this long before retrying. */
const RETRY_AFTER_MS = 30_000;
/** Default budget for embedding one query, ms. */
export const SEMANTIC_QUERY_TIMEOUT_MS = 3000;
const MAX_ROWS_PER_FILE = 2;
const STORE_FORMAT = 1;

/** The text embedded for a symbol: its signature (or kind and name) and its path from the root. */
export function semanticDoc(root: string, s: Symbol): string {
	const sig = (s.signature || `${s.kind} ${s.name}`)
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, SIGNATURE_MAX);
	const rel = path.relative(root, s.filePath).split(path.sep).join("/");
	return `${sig} ${rel}`;
}

export type SemanticStatus =
	| { state: "ready"; count: number }
	| { state: "building"; done: number; total: number }
	| { state: "unavailable"; reason: string }
	| { state: "none" };

export interface SemanticHit {
	symbol: Symbol;
	score: number;
}

export interface SemanticAnswer {
	status: "ready" | "building" | "unavailable" | "timeout" | "error";
	hits: SemanticHit[];
	/** Building: vectors embedded so far, and how many the build needs. */
	done?: number;
	total?: number;
	detail?: string;
}

export interface SemanticOptions {
	/** Embedder. Default: the nomic client over Ollama. */
	provider?: EmbeddingProvider;
	/** Budget for embedding the query, ms. Default 3000. */
	queryTimeoutMs?: number;
	/** Rows returned. Default 5. */
	k?: number;
}

interface Built {
	gen: number;
	model: string;
	dims: number;
	symbols: Symbol[];
	/** symbols.length rows of dims floats, each row unit length. */
	matrix: Float32Array;
}

interface RepoState {
	built: Built | null;
	building: Promise<SemanticStatus> | null;
	progress: { done: number; total: number };
	failedAt: number;
	failure: string;
	/** Raw vectors by text hash, per model: what the store on disk holds plus what was embedded since. */
	vectors: Map<string, Map<string, Float32Array>>;
}

const states = new Map<string, RepoState>();
let defaultProvider: EmbeddingProvider | null = null;

function stateFor(repoId: string): RepoState {
	let s = states.get(repoId);
	if (!s) {
		s = {
			built: null,
			building: null,
			progress: { done: 0, total: 0 },
			failedAt: 0,
			failure: "",
			vectors: new Map(),
		};
		states.set(repoId, s);
	}
	return s;
}

function providerOf(opts?: SemanticOptions): EmbeddingProvider {
	if (opts?.provider) return opts.provider;
	defaultProvider ??= new OllamaEmbeddingProvider();
	return defaultProvider;
}

async function providerAvailable(p: EmbeddingProvider): Promise<boolean> {
	const check = (p as { checkAvailability?: () => Promise<boolean> }).checkAvailability;
	if (typeof check === "function") {
		try {
			return await check.call(p);
		} catch {
			return false;
		}
	}
	return p.available;
}

function hashText(text: string): string {
	return createHash("sha1").update(text).digest("hex").slice(0, 20);
}

function modelSlug(model: string): string {
	return model.replace(/[^\w.-]+/g, "_");
}

function storePaths(repoId: string, model: string): { bin: string; meta: string } | null {
	const cacheRoot = getRepoCacheRoot(repoId);
	const repo = getRepoStats(repoId);
	if (!cacheRoot || !repo) return null;
	const base = path.join(
		repoCacheDir(cacheRoot, repo.sourceRoot),
		`embeddings-${modelSlug(model)}`,
	);
	return { bin: `${base}.f32`, meta: `${base}.json` };
}

function loadStore(repoId: string, model: string): Map<string, Float32Array> {
	const out = new Map<string, Float32Array>();
	const paths = storePaths(repoId, model);
	if (!paths) return out;
	try {
		const meta = JSON.parse(fs.readFileSync(paths.meta, "utf8")) as {
			format: number;
			model: string;
			dims: number;
			hashes: string[];
		};
		if (meta.format !== STORE_FORMAT || meta.model !== model || !Array.isArray(meta.hashes))
			return out;
		const buf = fs.readFileSync(paths.bin);
		if (buf.byteLength !== meta.hashes.length * meta.dims * 4) return out;
		// Copy: a Buffer's offset into its pool need not be 4-byte aligned.
		const all = new Float32Array(new Uint8Array(buf).buffer);
		meta.hashes.forEach((h, i) => out.set(h, all.subarray(i * meta.dims, (i + 1) * meta.dims)));
	} catch {
		// No store yet, or unreadable: embed from scratch.
	}
	return out;
}

function saveStore(
	repoId: string,
	model: string,
	vectors: Map<string, Float32Array>,
	keep: Set<string>,
): void {
	const paths = storePaths(repoId, model);
	if (!paths) return;
	const hashes = [...keep].filter((h) => vectors.has(h));
	const dims = hashes.length ? vectors.get(hashes[0])!.length : 0;
	const all = new Float32Array(hashes.length * dims);
	hashes.forEach((h, i) => all.set(vectors.get(h)!, i * dims));
	const tag = `${process.pid}.${Date.now()}.tmp`;
	try {
		fs.mkdirSync(path.dirname(paths.bin), { recursive: true });
		fs.writeFileSync(`${paths.bin}.${tag}`, new Uint8Array(all.buffer));
		fs.writeFileSync(
			`${paths.meta}.${tag}`,
			JSON.stringify({ format: STORE_FORMAT, model, dims, hashes }),
		);
		fs.renameSync(`${paths.bin}.${tag}`, paths.bin);
		fs.renameSync(`${paths.meta}.${tag}`, paths.meta);
	} catch {
		for (const f of [`${paths.bin}.${tag}`, `${paths.meta}.${tag}`]) {
			try {
				fs.rmSync(f, { force: true });
			} catch {}
		}
	}
}

/** Where the semantic index of a repo stands. */
export function semanticStatus(repoId: string): SemanticStatus {
	const s = states.get(repoId);
	if (!s) return { state: "none" };
	if (s.building) return { state: "building", ...s.progress };
	if (s.built) return { state: "ready", count: s.built.symbols.length };
	if (s.failedAt) return { state: "unavailable", reason: s.failure };
	return { state: "none" };
}

/** Forget a repo's semantic index in this process (the store on disk stays). */
export function clearSemanticIndex(repoId: string): void {
	states.delete(repoId);
}

/**
 * Build (or bring up to date) the semantic index for an indexed repo, and
 * wait for it. Embeds only texts the store does not hold. Never throws.
 */
export function ensureSemanticIndex(
	repoId: string,
	opts?: SemanticOptions,
): Promise<SemanticStatus> {
	const st = stateFor(repoId);
	if (st.building) return st.building;
	if (st.built && st.built.gen === indexGeneration(repoId)) {
		return Promise.resolve({ state: "ready", count: st.built.symbols.length });
	}
	const repo = getRepoStats(repoId);
	if (!repo) {
		return Promise.resolve({ state: "unavailable", reason: "the repo has no AST index" });
	}
	const provider = providerOf(opts);
	const model = provider.model;
	const gen = indexGeneration(repoId);

	// Everything up to the first await is synchronous, so the status is
	// "building" with its total the moment this returns.
	const symbols: Symbol[] = [];
	const texts: string[] = [];
	for (const rel of getFileTree(repoId)) {
		for (const s of getFileOutline(repoId, rel)?.symbols ?? []) {
			if (!SEMANTIC_KINDS.has(s.kind)) continue;
			symbols.push(s);
			texts.push(semanticDoc(repo.sourceRoot, s));
		}
	}
	const hashes = texts.map(hashText);
	let vectors = st.vectors.get(model);
	if (!vectors) {
		vectors = loadStore(repoId, model);
		st.vectors.set(model, vectors);
	}
	const store = vectors;
	const missing = new Map<string, string>();
	hashes.forEach((h, i) => {
		if (!store.has(h)) missing.set(h, texts[i]);
	});
	st.progress = { done: 0, total: missing.size };

	const run = (async (): Promise<SemanticStatus> => {
		if (!(await providerAvailable(provider))) {
			return fail(st, `the embedding model (${model}) is not available`);
		}
		const todo = [...missing];
		let sinceSave = 0;
		try {
			for (let i = 0; i < todo.length; i += BATCH) {
				const chunk = todo.slice(i, i + BATCH);
				const got = await provider.generateBatch(chunk.map(([, t]) => DOC_PREFIX + t));
				chunk.forEach(([h], j) => {
					if (got[j]?.length) store.set(h, got[j]);
				});
				st.progress = { done: Math.min(todo.length, i + chunk.length), total: todo.length };
				sinceSave += chunk.length;
				if (sinceSave >= SAVE_EVERY) {
					saveStore(repoId, model, store, new Set(hashes));
					sinceSave = 0;
				}
			}
		} catch (err) {
			saveStore(repoId, model, store, new Set(hashes));
			return fail(st, err instanceof Error ? err.message : String(err));
		}
		// Written only when something new was embedded (the store also drops
		// vectors no current symbol uses then), never on a rebuild that
		// reused every vector.
		if (todo.length > 0) saveStore(repoId, model, store, new Set(hashes));

		const kept: Symbol[] = [];
		const rows: Float32Array[] = [];
		hashes.forEach((h, i) => {
			const v = store.get(h);
			if (v?.length) {
				kept.push(symbols[i]);
				rows.push(v);
			}
		});
		const dims = rows[0]?.length ?? 0;
		const matrix = new Float32Array(rows.length * dims);
		rows.forEach((v, i) => {
			if (v.length !== dims) return;
			let norm = 0;
			for (let d = 0; d < dims; d++) norm += v[d] * v[d];
			const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0;
			for (let d = 0; d < dims; d++) matrix[i * dims + d] = v[d] * inv;
		});
		st.built = { gen, model, dims, symbols: kept, matrix };
		st.failedAt = 0;
		return { state: "ready", count: kept.length };
	})().finally(() => {
		if (states.get(repoId) === st) st.building = null;
	});
	st.building = run;
	return run;
}

function fail(st: RepoState, reason: string): SemanticStatus {
	st.failedAt = Date.now();
	st.failure = reason;
	return { state: "unavailable", reason };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<"timeout">((r) => {
		timer = setTimeout(() => r("timeout"), ms);
	});
	work.catch(() => {});
	return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * The symbols nearest in meaning to `query`. Lazy: the first call starts the
 * build and answers "building"; an index that went stale since it was built
 * is brought up to date in the background while this answer uses the last
 * one. Never throws.
 */
export async function semanticSearch(
	repoId: string,
	query: string,
	opts?: SemanticOptions,
): Promise<SemanticAnswer> {
	if (!getRepoStats(repoId)) {
		return { status: "unavailable", hits: [], detail: "the repo has no AST index" };
	}
	const st = stateFor(repoId);
	const provider = providerOf(opts);
	if (!st.built || st.built.model !== provider.model) {
		if (st.building) return { status: "building", hits: [], ...st.progress };
		if (st.failedAt && Date.now() - st.failedAt < RETRY_AFTER_MS) {
			return { status: "unavailable", hits: [], detail: st.failure };
		}
		if (!(await providerAvailable(provider))) {
			fail(st, `the embedding model (${provider.model}) is not available`);
			return { status: "unavailable", hits: [], detail: st.failure };
		}
		void ensureSemanticIndex(repoId, opts);
		return { status: "building", hits: [], ...st.progress };
	}
	const built = st.built;
	if (built.gen !== indexGeneration(repoId) && !st.building) void ensureSemanticIndex(repoId, opts);

	let q: Float32Array | "timeout";
	try {
		q = await withTimeout(
			provider.generate(QUERY_PREFIX + query),
			opts?.queryTimeoutMs ?? SEMANTIC_QUERY_TIMEOUT_MS,
		);
	} catch (err) {
		return { status: "error", hits: [], detail: err instanceof Error ? err.message : String(err) };
	}
	if (q === "timeout") return { status: "timeout", hits: [] };
	if (q.length !== built.dims) {
		return { status: "error", hits: [], detail: "query vector has the wrong size" };
	}
	return { status: "ready", hits: nearest(repoId, built, q, opts?.k ?? 5) };
}

/** Cosine top-k over the unit rows, at most MAX_ROWS_PER_FILE per file, skipping symbols since removed. */
function nearest(repoId: string, built: Built, q: Float32Array, k: number): SemanticHit[] {
	const { dims, matrix, symbols } = built;
	let qn = 0;
	for (let d = 0; d < dims; d++) qn += q[d] * q[d];
	const inv = qn > 0 ? 1 / Math.sqrt(qn) : 0;
	const scores = new Float32Array(symbols.length);
	for (let i = 0; i < symbols.length; i++) {
		let dot = 0;
		const off = i * dims;
		for (let d = 0; d < dims; d++) dot += matrix[off + d] * q[d];
		scores[i] = dot * inv;
	}
	const order = Array.from(scores.keys()).sort(
		(a, b) => scores[b] - scores[a] || (symbols[a].id < symbols[b].id ? -1 : 1),
	);
	const perFile = new Map<string, number>();
	const out: SemanticHit[] = [];
	for (const i of order) {
		const current = getSymbol(repoId, symbols[i].id);
		if (!current) continue;
		const n = perFile.get(current.filePath) ?? 0;
		if (n >= MAX_ROWS_PER_FILE) continue;
		perFile.set(current.filePath, n + 1);
		out.push({ symbol: current, score: Number(scores[i].toFixed(4)) });
		if (out.length === k) break;
	}
	return out;
}
