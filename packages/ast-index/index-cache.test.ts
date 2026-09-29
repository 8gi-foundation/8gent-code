/**
 * Persisted AST index (M3a): a warm start loads the index from disk instead
 * of re-parsing every file, and only files whose mtime changed are parsed.
 * Every test uses its own temp cache dir; nothing is written under ~/.8gent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearIndex,
	ensureIndexed,
	flushIndexCache,
	getBuildInfo,
	getFileOutline,
	getFileTree,
	indexFolder,
	indexGeneration,
	refreshIndex,
	searchSymbols,
} from "./index";
import {
	INDEX_CACHE_FILE,
	defaultCacheRoot,
	loadIndexCache,
	pruneIndexCaches,
	repoCacheDir,
} from "./index-cache";

let root: string;
let cacheRoot: string;

function write(rel: string, content: string, mtime?: Date): void {
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
	if (mtime) fs.utimesSync(abs, mtime, mtime);
}

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ast-cache-repo-")));
	cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ast-cache-store-"));
	write("a.ts", "export function alphaOne(x: number) { return x; }\nexport class AlphaBox {}\n");
	write("b/b.ts", "/** Beta docs. */\nexport function betaTwo() {}\n");
	write("c.tsx", "export const Gamma = () => null;\n");
});

afterEach(() => {
	clearIndex(root);
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(cacheRoot, { recursive: true, force: true });
});

/** Everything a caller can read back from an index, for equality checks. */
function snapshot(repoId: string) {
	return getFileTree(repoId).map((f) => getFileOutline(repoId, f));
}

describe("index cache", () => {
	test("a cold build writes the cache and a warm start parses nothing", async () => {
		const cold = await indexFolder(root, { cacheDir: cacheRoot });
		expect(getBuildInfo(cold.id)).toMatchObject({ fromCache: false, parsed: 3, reused: 0 });
		expect(fs.existsSync(path.join(repoCacheDir(cacheRoot, root), INDEX_CACHE_FILE))).toBe(true);
		const before = snapshot(cold.id);
		clearIndex(cold.id);

		const warm = await indexFolder(root, { cacheDir: cacheRoot });
		expect(getBuildInfo(warm.id)).toMatchObject({ fromCache: true, parsed: 0, reused: 3 });
		expect(warm.fileCount).toBe(3);
		expect(warm.symbolCount).toBe(cold.symbolCount);
		expect(snapshot(warm.id)).toEqual(before);
		expect(searchSymbols(warm.id, "betaTwo")[0]?.docstring).toContain("Beta docs.");
		expect(searchSymbols(warm.id, "betaTwo")[0]?.filePath).toBe(path.join(root, "b/b.ts"));
	});

	test("only a file whose mtime changed is parsed again; added and deleted files are seen", async () => {
		await indexFolder(root, { cacheDir: cacheRoot });
		clearIndex(root);
		write("a.ts", "export function alphaRenamed() {}\n", new Date(Date.now() + 5000));
		fs.rmSync(path.join(root, "c.tsx"));
		write("d.ts", "export function deltaNew() {}\n");

		const warm = await indexFolder(root, { cacheDir: cacheRoot });
		expect(getBuildInfo(warm.id)).toMatchObject({
			fromCache: true,
			parsed: 2,
			reused: 1,
			removed: 1,
		});
		expect(searchSymbols(warm.id, "alphaOne")).toEqual([]);
		expect(searchSymbols(warm.id, "alphaRenamed")[0]?.name).toBe("alphaRenamed");
		expect(searchSymbols(warm.id, "deltaNew")[0]?.name).toBe("deltaNew");
		expect(searchSymbols(warm.id, "Gamma")).toEqual([]);

		// The warm start wrote the changes back, so the next start parses nothing.
		clearIndex(root);
		const again = await indexFolder(root, { cacheDir: cacheRoot });
		expect(getBuildInfo(again.id)).toMatchObject({ fromCache: true, parsed: 0, reused: 3 });
	});

	test("a corrupt cache file is ignored and rebuilt, never thrown", async () => {
		await indexFolder(root, { cacheDir: cacheRoot });
		clearIndex(root);
		fs.writeFileSync(path.join(repoCacheDir(cacheRoot, root), INDEX_CACHE_FILE), "{ not json");
		const idx = await indexFolder(root, { cacheDir: cacheRoot });
		expect(getBuildInfo(idx.id)).toMatchObject({ fromCache: false, parsed: 3 });
		expect(loadIndexCache(cacheRoot, root, ["node_modules"])).toBeNull();
	});

	test("a cache written with other ignore patterns or another parser version is not reused", async () => {
		await indexFolder(root, { cacheDir: cacheRoot });
		clearIndex(root);
		const other = await indexFolder(root, { cacheDir: cacheRoot, ignorePatterns: ["b"] });
		expect(getBuildInfo(other.id)).toMatchObject({ fromCache: false });
		expect(other.fileCount).toBe(2);

		clearIndex(root);
		const file = path.join(repoCacheDir(cacheRoot, root), INDEX_CACHE_FILE);
		const data = JSON.parse(fs.readFileSync(file, "utf8"));
		data.parser = "some-older-parser";
		fs.writeFileSync(file, JSON.stringify(data));
		const again = await indexFolder(root, { cacheDir: cacheRoot, ignorePatterns: ["b"] });
		expect(getBuildInfo(again.id)).toMatchObject({ fromCache: false });
	});

	test("without a cacheDir nothing is written", async () => {
		await indexFolder(root);
		expect(fs.readdirSync(cacheRoot)).toEqual([]);
		expect(getBuildInfo(root)).toMatchObject({ fromCache: false, parsed: 3 });
	});

	test("changes a refresh picks up are written back when flushed", async () => {
		const idx = await indexFolder(root, { cacheDir: cacheRoot });
		const gen = indexGeneration(idx.id);
		write("e.ts", "export function epsilonLate() {}\n");
		expect(refreshIndex(idx.id)).toEqual({ added: 1, changed: 0, removed: 0 });
		expect(indexGeneration(idx.id)).toBeGreaterThan(gen);
		await flushIndexCache(idx.id);

		clearIndex(root);
		const warm = await indexFolder(root, { cacheDir: cacheRoot });
		expect(getBuildInfo(warm.id)).toMatchObject({ fromCache: true, parsed: 0, reused: 4 });
		expect(searchSymbols(warm.id, "epsilonLate")[0]?.name).toBe("epsilonLate");
	});

	test("a refresh that changes nothing keeps the generation", async () => {
		const idx = await indexFolder(root, { cacheDir: cacheRoot });
		const gen = indexGeneration(idx.id);
		refreshIndex(idx.id);
		expect(indexGeneration(idx.id)).toBe(gen);
	});

	test("ensureIndexed persists to the given cacheDir and warm-starts from it", async () => {
		await ensureIndexed(root, { cacheDir: cacheRoot });
		clearIndex(root);
		const warm = await ensureIndexed(root, { cacheDir: cacheRoot });
		expect(getBuildInfo(warm.id)).toMatchObject({ fromCache: true, parsed: 0 });
	});
});

describe("cache location", () => {
	test("defaults under EIGHT_DATA_DIR or ~/.8gent, and can be turned off", () => {
		expect(defaultCacheRoot({ EIGHT_DATA_DIR: "/x/data" })).toBe(path.join("/x/data", "ast-index"));
		expect(defaultCacheRoot({})).toBe(path.join(os.homedir(), ".8gent", "ast-index"));
		for (const off of ["0", "off", "false", "OFF"]) {
			expect(defaultCacheRoot({ EIGHT_AST_INDEX_CACHE: off })).toBeNull();
		}
		// bun test sets NODE_ENV=test: the default never writes under the real home.
		expect(defaultCacheRoot({ NODE_ENV: "test" })).toBeNull();
		expect(defaultCacheRoot()).toBeNull();
	});

	test("two roots get two cache dirs", () => {
		expect(repoCacheDir(cacheRoot, "/x/a/app")).not.toBe(repoCacheDir(cacheRoot, "/x/b/app"));
	});

	test("prune removes caches whose repo root no longer exists and keeps the rest", async () => {
		await indexFolder(root, { cacheDir: cacheRoot });
		const gone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ast-cache-gone-")));
		fs.writeFileSync(path.join(gone, "g.ts"), "export const g = 1;\n");
		await indexFolder(gone, { cacheDir: cacheRoot });
		clearIndex(gone);
		fs.rmSync(gone, { recursive: true, force: true });
		expect(fs.readdirSync(cacheRoot).length).toBe(2);
		expect(pruneIndexCaches(cacheRoot)).toBe(1);
		expect(fs.readdirSync(cacheRoot)).toEqual([path.basename(repoCacheDir(cacheRoot, root))]);
	});
});
