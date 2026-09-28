/**
 * On-disk AST index cache (M3a).
 *
 * One JSON file per repo root under <EIGHT_DATA_DIR or ~/.8gent>/ast-index/
 * <hash of root>/index.json, holding every indexed file's outline and the
 * mtime it was parsed at. A warm start reads it, stats each file, and parses
 * only files whose mtime differs (or that are new); files that are gone are
 * dropped. A cache written by another parser (source or TypeScript version)
 * or with other ignore patterns is not used.
 *
 * Symbols are stored with the absolute file path taken out of the id and
 * filePath (it is the root plus the file's relative path), which keeps the
 * file small and the read fast. Writes go to a temp file and are renamed into
 * place, so a reader never sees half a file. Env EIGHT_AST_INDEX_CACHE=0
 * (or off, false) turns the cache off.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as ts from "typescript";
import type { FileOutline, Symbol, SymbolKind } from "../types";

export const INDEX_CACHE_FILE = "index.json";
const CACHE_FORMAT = 1;

/** Changes when the parser or its TypeScript changes, so old outlines are never reused. */
const PARSER_FINGERPRINT = (() => {
	let source = "";
	try {
		source = fs.readFileSync(path.join(import.meta.dir, "typescript-parser.ts"), "utf8");
	} catch {
		// Bundled builds have no source file; the TypeScript version still keys the cache.
	}
	return createHash("sha1").update(`${ts.version}\n${source}`).digest("hex").slice(0, 16);
})();

/**
 * Where caches live, or null when env EIGHT_AST_INDEX_CACHE turns them off.
 * Also null under `bun test` (NODE_ENV=test), so a test that indexes a temp
 * dir never writes under the user's home; tests pass a cacheDir instead.
 */
export function defaultCacheRoot(
	env: Record<string, string | undefined> = process.env,
): string | null {
	const flag = (env.EIGHT_AST_INDEX_CACHE ?? "").trim().toLowerCase();
	if (flag === "0" || flag === "off" || flag === "false") return null;
	if (env.NODE_ENV === "test") return null;
	return path.join(env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent"), "ast-index");
}

/** The cache dir for one repo root. */
export function repoCacheDir(cacheRoot: string, root: string): string {
	return path.join(cacheRoot, createHash("sha1").update(root).digest("hex").slice(0, 16));
}

/** One indexed file as the cache holds it. */
export interface CachedFile {
	rel: string;
	mtimeMs: number;
	outline: FileOutline;
}

/** [id without the file path, name, kind, startLine, endLine, signature, docstring, summary] */
type PackedSymbol = [
	string,
	string,
	SymbolKind,
	number,
	number,
	string | null,
	string | null,
	string | null,
];
/** [relative path, mtimeMs, language, symbols] */
type PackedFile = [string, number, string, PackedSymbol[]];

interface CacheData {
	format: number;
	parser: string;
	root: string;
	ignore: string[];
	savedAt: string;
	files: PackedFile[];
}

function pack(root: string, f: CachedFile): PackedFile {
	const abs = path.join(root, f.rel);
	return [
		f.rel,
		f.mtimeMs,
		f.outline.language,
		f.outline.symbols.map((s) => [
			s.id.startsWith(`${abs}::`) ? s.id.slice(abs.length) : s.id,
			s.name,
			s.kind,
			s.startLine,
			s.endLine,
			s.signature ?? null,
			s.docstring ?? null,
			s.summary ?? null,
		]),
	];
}

function unpack(root: string, [rel, mtimeMs, language, packed]: PackedFile): CachedFile {
	const abs = path.join(root, rel);
	const symbols = packed.map(
		([id, name, kind, startLine, endLine, signature, docstring, summary]) => {
			const s: Symbol = {
				id: id.startsWith("::") ? abs + id : id,
				name,
				kind,
				filePath: abs,
				startLine,
				endLine,
			};
			// Keys the parser leaves out stay out, so a loaded outline equals a parsed one.
			if (signature !== null) s.signature = signature;
			if (docstring !== null) s.docstring = docstring;
			if (summary !== null) s.summary = summary;
			return s;
		},
	);
	return { rel, mtimeMs, outline: { filePath: abs, language, symbols } };
}

/**
 * The cached files for `root`, keyed by relative path, or null when there is
 * no usable cache (missing, unreadable, another format, parser or ignore list).
 */
export function loadIndexCache(
	cacheRoot: string,
	root: string,
	ignore: string[],
): Map<string, CachedFile> | null {
	let data: CacheData;
	try {
		data = JSON.parse(
			fs.readFileSync(path.join(repoCacheDir(cacheRoot, root), INDEX_CACHE_FILE), "utf8"),
		);
	} catch {
		return null;
	}
	if (
		!data ||
		data.format !== CACHE_FORMAT ||
		data.parser !== PARSER_FINGERPRINT ||
		data.root !== root ||
		!Array.isArray(data.files) ||
		JSON.stringify(data.ignore) !== JSON.stringify(ignore)
	) {
		return null;
	}
	const out = new Map<string, CachedFile>();
	try {
		for (const f of data.files) out.set(f[0], unpack(root, f));
	} catch {
		return null;
	}
	return out;
}

/** Write the cache for `root` atomically. Never throws; returns whether it was written. */
export function saveIndexCache(
	cacheRoot: string,
	root: string,
	ignore: string[],
	files: Iterable<CachedFile>,
): boolean {
	const dir = repoCacheDir(cacheRoot, root);
	const target = path.join(dir, INDEX_CACHE_FILE);
	const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.mkdirSync(dir, { recursive: true });
		const data: CacheData = {
			format: CACHE_FORMAT,
			parser: PARSER_FINGERPRINT,
			root,
			ignore,
			savedAt: new Date().toISOString(),
			files: Array.from(files, (f) => pack(root, f)),
		};
		fs.writeFileSync(tmp, JSON.stringify(data));
		fs.renameSync(tmp, target);
		return true;
	} catch {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {}
		return false;
	}
}

/**
 * Remove caches whose repo root no longer exists (temp checkouts, deleted
 * clones). Reads only the start of each index file to find its root.
 * Returns how many were removed. Never throws.
 */
export function pruneIndexCaches(cacheRoot: string): number {
	let removed = 0;
	let entries: string[];
	try {
		entries = fs.readdirSync(cacheRoot);
	} catch {
		return 0;
	}
	for (const name of entries) {
		const dir = path.join(cacheRoot, name);
		const root = readCachedRoot(path.join(dir, INDEX_CACHE_FILE));
		if (root === undefined || fs.existsSync(root)) continue;
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			removed++;
		} catch {}
	}
	return removed;
}

/** The "root" field of a cache file from its first bytes; undefined when unreadable. */
function readCachedRoot(file: string): string | undefined {
	try {
		const fd = fs.openSync(file, "r");
		try {
			const buf = Buffer.alloc(8192);
			const n = fs.readSync(fd, buf, 0, buf.length, 0);
			const m = /"root":("(?:[^"\\]|\\.)*")/.exec(buf.subarray(0, n).toString("utf8"));
			return m ? (JSON.parse(m[1]) as string) : undefined;
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
}
