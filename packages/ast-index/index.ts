/**
 * 8gent AST Index
 *
 * Symbol-level code retrieval for token-efficient agent workflows.
 * Instead of reading entire files, agents retrieve specific symbols.
 *
 * Inspired by jcodemunch, but native to 8gent.
 */

import type { FileOutline, RepoIndex, Symbol, SymbolKind } from "../types";
export type { RepoIndex, FileOutline, Symbol, SymbolKind };
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type CachedFile,
	defaultCacheRoot,
	loadIndexCache,
	pruneIndexCaches,
	saveIndexCache,
} from "./index-cache";
import { matchTier } from "./rank";
import { parseTypeScriptFile } from "./typescript-parser";

/**
 * Repo-relative paths are "/" separated on every OS: index keys, getFileTree,
 * and locate rows. Accepts a Windows-style backslash path and returns the
 * canonical form (no leading "./").
 */
export function normalizeRelPath(p: string): string {
	return p.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

/** `file` made relative to `root`, in the canonical "/" form. */
export function relativePosix(root: string, file: string): string {
	return normalizeRelPath(path.relative(root, file));
}

// Parser interface - will be implemented with tree-sitter or native TS parser
export interface Parser {
	parse(code: string, language: string): ParsedFile;
	getSupportedLanguages(): string[];
}

export interface ParsedFile {
	symbols: ParsedSymbol[];
	imports: string[];
	exports: string[];
}

export interface ParsedSymbol {
	name: string;
	kind: SymbolKind;
	startLine: number;
	endLine: number;
	startCol: number;
	endCol: number;
	signature?: string;
	docstring?: string;
	children?: ParsedSymbol[];
}

// ============================================
// Index Storage (in memory; persisted per repo by index-cache.ts when a cacheDir is given)
// ============================================

const repoIndices: Map<string, RepoIndex> = new Map();
const symbolMaps: Map<string, Map<string, Symbol>> = new Map();
const fileOutlines: Map<string, Map<string, FileOutline>> = new Map();
/** mtimeMs of each indexed file when it was last parsed, keyed by repo then relative path. */
const fileMtimes: Map<string, Map<string, number>> = new Map();
/** One build per absolute folder per process, shared by every caller. */
const sharedBuilds: Map<string, { promise: Promise<RepoIndex>; index: RepoIndex | null }> =
	new Map();

// ============================================
// Core API
// ============================================

const DEFAULT_IGNORE = ["node_modules", "dist", ".git", ".next", "coverage"];
const SOURCE_FILE_RE = /\.(ts|tsx|js|jsx)$/;
/** Files parsed between yields to the event loop during a build. */
const YIELD_EVERY = 50;
/** Ignore patterns each repo was built with, so a refresh walks the same tree. */
const repoIgnores: Map<string, string[]> = new Map();
/** Cache root each repo persists to (absent: memory only). */
const repoCacheRoots: Map<string, string> = new Map();
/** Bumped whenever a repo's symbols change, so derived data (embeddings) knows it is stale. */
const generations: Map<string, number> = new Map();
let generationCounter = 0;

/** How the last build of a repo went: from cache or cold, and what it parsed. */
export interface BuildInfo {
	fromCache: boolean;
	/** Files parsed (new or changed since the cache). */
	parsed: number;
	/** Files whose cached outline was used as is. */
	reused: number;
	/** Cached files no longer on disk. */
	removed: number;
	ms: number;
}
const buildInfos: Map<string, BuildInfo> = new Map();

/** A saved cache is rewritten this long after the last change a refresh saw. */
const CACHE_SAVE_DELAY_MS = 2000;
const pendingSaves: Map<string, ReturnType<typeof setTimeout>> = new Map();

function bumpGeneration(repoId: string): void {
	generations.set(repoId, ++generationCounter);
}

/** Changes whenever the repo's symbols change (build, refresh, fresh outline). 0: not indexed. */
export function indexGeneration(repoId: string): number {
	return generations.get(repoId) ?? 0;
}

/** How the repo's current index was built, or null when it is not indexed. */
export function getBuildInfo(repoId: string): BuildInfo | null {
	return buildInfos.get(repoId) ?? null;
}

/** The cache root a repo persists to, or null when it lives in memory only. */
export function getRepoCacheRoot(repoId: string): string | null {
	return repoCacheRoots.get(repoId) ?? null;
}

function cachedFiles(repoId: string): CachedFile[] {
	const outlines = fileOutlines.get(repoId);
	const mtimes = fileMtimes.get(repoId);
	if (!outlines || !mtimes) return [];
	const out: CachedFile[] = [];
	for (const [rel, outline] of outlines) {
		const mtimeMs = mtimes.get(rel);
		if (mtimeMs !== undefined) out.push({ rel, mtimeMs, outline });
	}
	return out;
}

function writeCache(repoId: string): void {
	const cacheRoot = repoCacheRoots.get(repoId);
	const repo = repoIndices.get(repoId);
	if (!cacheRoot || !repo) return;
	saveIndexCache(
		cacheRoot,
		repo.sourceRoot,
		repoIgnores.get(repoId) ?? DEFAULT_IGNORE,
		cachedFiles(repoId),
	);
}

/** A repo's symbols changed: new generation, and a cache write a moment later. */
function markChanged(repoId: string): void {
	bumpGeneration(repoId);
	if (!repoCacheRoots.has(repoId)) return;
	const prev = pendingSaves.get(repoId);
	if (prev) clearTimeout(prev);
	const timer = setTimeout(() => {
		pendingSaves.delete(repoId);
		writeCache(repoId);
	}, CACHE_SAVE_DELAY_MS);
	// A pending save never keeps the process alive.
	(timer as { unref?: () => void }).unref?.();
	pendingSaves.set(repoId, timer);
}

/** Write a repo's pending cache update now (tests, and callers about to exit). */
export async function flushIndexCache(repoId: string): Promise<void> {
	const timer = pendingSaves.get(repoId);
	if (!timer) return;
	clearTimeout(timer);
	pendingSaves.delete(repoId);
	writeCache(repoId);
}

/** Every indexable source file under `root`, skipping ignored and dot entries. */
function listSourceFiles(root: string, ignorePatterns: string[]): string[] {
	const files: string[] = [];
	function walkDirectory(dir: string): void {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (ignorePatterns.some((p) => entry.name === p || entry.name.startsWith("."))) continue;
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walkDirectory(fullPath);
			} else if (SOURCE_FILE_RE.test(entry.name)) {
				files.push(fullPath);
			}
		}
	}
	walkDirectory(root);
	return files;
}

export interface IndexFolderOptions {
	incremental?: boolean;
	ignorePatterns?: string[];
	/**
	 * Cache root to load from and save to (see index-cache.ts). With one, a
	 * warm start reuses every file whose mtime is unchanged and parses only
	 * the rest. Absent or null: parse everything, keep the index in memory.
	 */
	cacheDir?: string | null;
}

/** Stats between yields when a warm start reuses cached outlines. */
const YIELD_EVERY_REUSED = 1000;

/**
 * Index a local folder.
 *
 * The repo id is the folder's resolved absolute path, so two folders that
 * share a basename never overwrite each other. The build yields to the event
 * loop every few files, so a caller that fires it and moves on is not blocked.
 */
export async function indexFolder(
	folderPath: string,
	options?: IndexFolderOptions,
): Promise<RepoIndex> {
	const t0 = performance.now();
	const absolutePath = path.resolve(folderPath);
	const repoId = absolutePath;
	const ignorePatterns = options?.ignorePatterns ?? DEFAULT_IGNORE;
	const cacheRoot = options?.cacheDir ?? null;
	const cached = cacheRoot ? loadIndexCache(cacheRoot, absolutePath, ignorePatterns) : null;

	const files = listSourceFiles(absolutePath, ignorePatterns);

	const repoSymbolMap = new Map<string, Symbol>();
	const repoFileOutlines = new Map<string, FileOutline>();
	const repoFileMtimes = new Map<string, number>();
	const languages: Record<string, number> = {};
	let parsed = 0;
	let reused = 0;
	let parsedAtYield = 0;
	let indexAtYield = 0;

	for (let i = 0; i < files.length; i++) {
		// Parsing is the slow part: yield every YIELD_EVERY parses, and every
		// YIELD_EVERY_REUSED files when outlines come from the cache.
		if (parsed - parsedAtYield >= YIELD_EVERY || i - indexAtYield >= YIELD_EVERY_REUSED) {
			await new Promise((r) => setImmediate(r));
			parsedAtYield = parsed;
			indexAtYield = i;
		}
		const file = files[i];
		try {
			const mtimeMs = fs.statSync(file).mtimeMs;
			const relativePath = relativePosix(absolutePath, file);
			const hit = cached?.get(relativePath);
			let outline: FileOutline;
			if (hit && hit.mtimeMs === mtimeMs) {
				outline = hit.outline;
				reused++;
			} else {
				outline = parseTypeScriptFile(file);
				parsed++;
			}
			repoFileOutlines.set(relativePath, outline);
			repoFileMtimes.set(relativePath, mtimeMs);

			const lang = outline.language;
			languages[lang] = (languages[lang] || 0) + 1;

			for (const symbol of outline.symbols) {
				repoSymbolMap.set(symbol.id, symbol);
			}
		} catch {
			// Skip files that fail to parse
		}
	}

	const repoIndex: RepoIndex = {
		id: repoId,
		sourceRoot: absolutePath,
		indexedAt: new Date().toISOString(),
		fileCount: repoFileOutlines.size,
		symbolCount: repoSymbolMap.size,
		languages,
	};

	repoIndices.set(repoId, repoIndex);
	symbolMaps.set(repoId, repoSymbolMap);
	fileOutlines.set(repoId, repoFileOutlines);
	fileMtimes.set(repoId, repoFileMtimes);
	repoIgnores.set(repoId, ignorePatterns);
	bumpGeneration(repoId);

	let removed = 0;
	if (cached) for (const rel of cached.keys()) if (!repoFileMtimes.has(rel)) removed++;
	if (cacheRoot) {
		repoCacheRoots.set(repoId, cacheRoot);
		// Written only when something differs from what was loaded.
		if (!cached || parsed > 0 || removed > 0) {
			saveIndexCache(cacheRoot, absolutePath, ignorePatterns, cachedFiles(repoId));
			// A cold build is when stale caches (deleted temp checkouts) get cleared.
			if (!cached) pruneIndexCaches(cacheRoot);
		}
	} else {
		repoCacheRoots.delete(repoId);
	}
	buildInfos.set(repoId, {
		fromCache: cached !== null,
		parsed,
		reused,
		removed,
		ms: Math.round(performance.now() - t0),
	});

	return repoIndex;
}

type RefreshCounts = { added: number; changed: number; removed: number };

/**
 * One refresh pass as steps: it yields after each file it stats, so a caller
 * can run it straight through (refreshIndex) or give the event loop a turn
 * between batches (refreshIndexAsync). Returns what changed, or null when the
 * repo is not indexed.
 */
function* refreshSteps(repoId: string): Generator<void, RefreshCounts | null, void> {
	const repo = repoIndices.get(repoId);
	const outlines = fileOutlines.get(repoId);
	const mtimes = fileMtimes.get(repoId);
	const symbols = symbolMaps.get(repoId);
	if (!repo || !outlines || !mtimes || !symbols) return null;

	const counts = { added: 0, changed: 0, removed: 0 };
	let files: string[];
	try {
		files = listSourceFiles(repo.sourceRoot, repoIgnores.get(repoId) ?? DEFAULT_IGNORE);
	} catch {
		return counts;
	}

	const seen = new Set<string>();
	for (const file of files) {
		yield;
		const rel = relativePosix(repo.sourceRoot, file);
		seen.add(rel);
		let mtimeMs: number;
		try {
			mtimeMs = fs.statSync(file).mtimeMs;
		} catch {
			continue;
		}
		if (mtimes.get(rel) === mtimeMs) continue;
		const current = outlines.get(rel);
		let next: FileOutline;
		try {
			next = parseTypeScriptFile(file);
		} catch {
			if (current) {
				dropFile(repo, outlines, mtimes, symbols, rel, current);
				counts.removed++;
			}
			continue;
		}
		if (current) for (const s of current.symbols) symbols.delete(s.id);
		for (const s of next.symbols) symbols.set(s.id, s);
		outlines.set(rel, next);
		mtimes.set(rel, mtimeMs);
		if (current) counts.changed++;
		else counts.added++;
	}
	for (const [rel, current] of outlines) {
		if (seen.has(rel)) continue;
		dropFile(repo, outlines, mtimes, symbols, rel, current);
		counts.removed++;
	}
	repo.fileCount = outlines.size;
	repo.symbolCount = symbols.size;
	if (counts.added + counts.changed + counts.removed > 0) markChanged(repoId);
	return counts;
}

/**
 * Bring a built index up to date with disk: parse files created or modified
 * since they were indexed, and drop files that were deleted. One readdir and
 * one stat per file, so it is cheap enough to run before every search.
 * Returns what changed, or null when the repo is not indexed. Runs on the
 * caller's stack; use refreshIndexAsync where a large tree must not block.
 */
export function refreshIndex(repoId: string): RefreshCounts | null {
	const steps = refreshSteps(repoId);
	for (let r = steps.next(); ; r = steps.next()) if (r.done) return r.value;
}

const refreshesInFlight = new Map<string, Promise<RefreshCounts | null>>();

/**
 * refreshIndex that gives the event loop a turn every YIELD_EVERY files, so a
 * refresh of a very large tree does not stall other work. Concurrent calls for
 * the same repo share one pass.
 */
export function refreshIndexAsync(repoId: string): Promise<RefreshCounts | null> {
	const inFlight = refreshesInFlight.get(repoId);
	if (inFlight) return inFlight;
	const run = (async () => {
		const steps = refreshSteps(repoId);
		for (let i = 1; ; i++) {
			const r = steps.next();
			if (r.done) return r.value;
			if (i % YIELD_EVERY === 0) await new Promise((res) => setImmediate(res));
		}
	})().finally(() => refreshesInFlight.delete(repoId));
	refreshesInFlight.set(repoId, run);
	return run;
}

/**
 * Index a folder once per process and share the result.
 *
 * Concurrent and repeat calls for the same folder get the same promise, so the
 * agent and every ToolExecutor pay for one build. A folder whose index was
 * cleared, or whose build failed, is rebuilt on the next call.
 */
export function ensureIndexed(
	folderPath: string,
	options?: { ignorePatterns?: string[]; cacheDir?: string | null },
): Promise<RepoIndex> {
	const key = path.resolve(folderPath);
	const cached = sharedBuilds.get(key);
	if (cached && (cached.index === null || repoIndices.get(cached.index.id) === cached.index)) {
		return cached.promise;
	}
	const entry = { index: null } as { promise: Promise<RepoIndex>; index: RepoIndex | null };
	// The shared build persists by default (see index-cache.ts), so the next
	// session loads instead of re-parsing the tree.
	const cacheDir = options && "cacheDir" in options ? options.cacheDir : defaultCacheRoot();
	entry.promise = indexFolder(key, { ...options, cacheDir }).then(
		(index) => {
			entry.index = index;
			return index;
		},
		(err) => {
			if (sharedBuilds.get(key) === entry) sharedBuilds.delete(key);
			throw err;
		},
	);
	sharedBuilds.set(key, entry);
	return entry.promise;
}

/**
 * Index a GitHub repository
 */
export async function indexRepo(
	url: string,
	options?: {
		branch?: string;
		sparse?: boolean;
	},
): Promise<RepoIndex> {
	throw new Error("Use indexFolder() with a local checkout. Remote indexing not yet supported.");
}

/**
 * Get file outline (all symbols in a file)
 */
export function getFileOutline(repoId: string, filePath: string): FileOutline | null {
	const repo = fileOutlines.get(repoId);
	if (!repo) return null;
	return repo.get(normalizeRelPath(filePath)) || null;
}

/**
 * Get a specific symbol by ID
 */
export function getSymbol(repoId: string, symbolId: string): Symbol | null {
	const repo = symbolMaps.get(repoId);
	if (!repo) return null;
	return repo.get(symbolId) || null;
}

/**
 * Get symbol source code
 */
export async function getSymbolSource(
	repoId: string,
	symbolId: string,
	contextLines = 0,
): Promise<string | null> {
	const symbol = getSymbol(repoId, symbolId);
	if (!symbol) return null;

	try {
		const content = fs.readFileSync(symbol.filePath, "utf-8");
		const lines = content.split("\n");
		const start = Math.max(0, symbol.startLine - 1 - contextLines);
		const end = Math.min(lines.length, symbol.endLine + contextLines);
		return lines.slice(start, end).join("\n");
	} catch {
		return null;
	}
}

export interface SearchSymbolsOptions {
	/** Keep only these kinds. */
	kinds?: string[];
	/** Regex tested against the symbol's file path. */
	filePattern?: string;
	/** Maximum results, applied after ranking. Default 20. */
	limit?: number;
	/** Also match signature and summary text, ranked after every name match. Default true. */
	matchSignature?: boolean;
}

/** Tier for a signature or summary match: below every name tier in rank.ts. */
const SIGNATURE_TIER = 4;

/**
 * Search symbols across a repo, ranked.
 *
 * Order: name tier (exact, prefix, camel token, substring; see rank.ts), then
 * signature/summary matches. Within a tier a case-sensitive exact name comes
 * first, then the shorter file path, then path order, then line. The order
 * never depends on insertion order, so the same query gives the same answer.
 */
export function searchSymbols(
	repoId: string,
	query: string,
	options?: SearchSymbolsOptions,
): Symbol[] {
	const repo = symbolMaps.get(repoId);
	query = query?.trim() ?? "";
	// A query with no identifier character (blank, punctuation) names no symbol.
	if (!repo || !/[\p{L}\p{N}_$]/u.test(query)) return [];

	const limit = options?.limit || 20;
	const kinds = options?.kinds;
	const pattern = options?.filePattern ? new RegExp(options.filePattern) : null;
	const matchSignature = options?.matchSignature ?? true;
	const queryLower = query.toLowerCase();

	const hits: { symbol: Symbol; tier: number; caseMiss: number }[] = [];
	for (const symbol of repo.values()) {
		if (kinds && !kinds.includes(symbol.kind)) continue;
		if (pattern && !pattern.test(symbol.filePath)) continue;

		let tier: number | null = matchTier(symbol.name, query, queryLower);
		if (tier === null && matchSignature) {
			const sigMatch = symbol.signature?.toLowerCase().includes(queryLower);
			const sumMatch = symbol.summary?.toLowerCase().includes(queryLower);
			if (sigMatch || sumMatch) tier = SIGNATURE_TIER;
		}
		if (tier === null) continue;
		hits.push({ symbol, tier, caseMiss: symbol.name === query ? 0 : 1 });
	}

	hits.sort(
		(a, b) =>
			a.tier - b.tier ||
			a.caseMiss - b.caseMiss ||
			a.symbol.filePath.length - b.symbol.filePath.length ||
			compareStrings(a.symbol.filePath, b.symbol.filePath) ||
			a.symbol.startLine - b.symbol.startLine ||
			compareStrings(a.symbol.id, b.symbol.id),
	);

	return hits.slice(0, limit).map((h) => h.symbol);
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Re-check one indexed file against disk and bring the index up to date.
 * Returns the current outline, or null when the file is not indexed (or was
 * deleted, in which case its symbols are dropped). `filePath` may be relative
 * to the repo root or absolute.
 */
export function getFreshFileOutline(repoId: string, filePath: string): FileOutline | null {
	const repo = repoIndices.get(repoId);
	const outlines = fileOutlines.get(repoId);
	const mtimes = fileMtimes.get(repoId);
	const symbols = symbolMaps.get(repoId);
	if (!repo || !outlines || !mtimes || !symbols) return null;

	const rel = path.isAbsolute(filePath)
		? relativePosix(repo.sourceRoot, filePath)
		: normalizeRelPath(path.normalize(filePath));
	const current = outlines.get(rel);
	if (!current) return null;

	let mtimeMs: number;
	try {
		mtimeMs = fs.statSync(path.join(repo.sourceRoot, rel)).mtimeMs;
	} catch {
		dropFile(repo, outlines, mtimes, symbols, rel, current);
		return null;
	}
	if (mtimes.get(rel) === mtimeMs) return current;

	let next: FileOutline;
	try {
		next = parseTypeScriptFile(path.join(repo.sourceRoot, rel));
	} catch {
		dropFile(repo, outlines, mtimes, symbols, rel, current);
		return null;
	}
	for (const s of current.symbols) symbols.delete(s.id);
	for (const s of next.symbols) symbols.set(s.id, s);
	outlines.set(rel, next);
	mtimes.set(rel, mtimeMs);
	repo.symbolCount = symbols.size;
	markChanged(repo.id);
	return next;
}

function dropFile(
	repo: RepoIndex,
	outlines: Map<string, FileOutline>,
	mtimes: Map<string, number>,
	symbols: Map<string, Symbol>,
	rel: string,
	current: FileOutline,
): void {
	for (const s of current.symbols) symbols.delete(s.id);
	outlines.delete(rel);
	mtimes.delete(rel);
	repo.fileCount = outlines.size;
	repo.symbolCount = symbols.size;
	markChanged(repo.id);
}

/**
 * Get file tree for a repo
 */
export function getFileTree(repoId: string, pathPrefix?: string): string[] {
	const outlines = fileOutlines.get(repoId);
	if (!outlines) return [];

	let paths = Array.from(outlines.keys());

	if (pathPrefix) {
		const prefix = normalizeRelPath(pathPrefix);
		paths = paths.filter((p) => p.startsWith(prefix));
	}

	return paths.sort();
}

/**
 * List all indexed repos
 */
export function listRepos(): RepoIndex[] {
	return Array.from(repoIndices.values());
}

/**
 * Get repo stats
 */
export function getRepoStats(repoId: string): RepoIndex | null {
	return repoIndices.get(repoId) || null;
}

/**
 * Clear index for a repo
 */
export function clearIndex(repoId: string): boolean {
	const had = repoIndices.has(repoId);
	repoIndices.delete(repoId);
	symbolMaps.delete(repoId);
	fileOutlines.delete(repoId);
	fileMtimes.delete(repoId);
	repoIgnores.delete(repoId);
	repoCacheRoots.delete(repoId);
	buildInfos.delete(repoId);
	generations.delete(repoId);
	const pending = pendingSaves.get(repoId);
	if (pending) clearTimeout(pending);
	pendingSaves.delete(repoId);
	return had;
}

// ============================================
// Token Estimation
// ============================================

/**
 * Estimate tokens for a file vs symbol retrieval
 */
export function estimateTokenSavings(
	repoId: string,
	filePath: string,
	symbolIds?: string[],
): {
	fullFileTokens: number;
	symbolOnlyTokens: number;
	savingsPercent: number;
} {
	const outline = fileOutlines.get(repoId)?.get(normalizeRelPath(filePath));
	if (!outline) {
		return { fullFileTokens: 0, symbolOnlyTokens: 0, savingsPercent: 0 };
	}

	let fullFileTokens = 0;
	try {
		const stats = fs.statSync(outline.filePath);
		fullFileTokens = Math.ceil(stats.size / 4);
	} catch {
		return { fullFileTokens: 0, symbolOnlyTokens: 0, savingsPercent: 0 };
	}

	const symbols = symbolIds
		? outline.symbols.filter((s) => symbolIds.includes(s.id))
		: outline.symbols;

	const symbolLines = symbols.reduce((sum, s) => sum + (s.endLine - s.startLine + 1), 0);
	const symbolOnlyTokens = Math.ceil((symbolLines * 40) / 4); // ~40 chars per line estimate

	const savingsPercent =
		fullFileTokens > 0
			? Math.round(((fullFileTokens - symbolOnlyTokens) / fullFileTokens) * 100)
			: 0;

	return { fullFileTokens, symbolOnlyTokens, savingsPercent };
}
