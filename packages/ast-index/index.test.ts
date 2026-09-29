/**
 * AST index: ranked symbol search, one shared build per folder, and fresh
 * per-file outlines. Fixtures are written to a temp dir so the repo's own
 * index (and the real-query eval) never sees these symbols.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearIndex,
	ensureIndexed,
	getFreshFileOutline,
	indexFolder,
	refreshIndex,
	refreshIndexAsync,
	searchSymbols,
} from "./index";
import { camelTokens, matchTier } from "./rank";

let root: string;
let repoId: string;

function write(rel: string, content: string): void {
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
}

beforeAll(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ast-index-rank-"));
	// Tier fixtures for the query "parse".
	write("tiers.ts", "export function reparse() {}\nexport function fileParse() {}\n");
	write("tiers2.ts", "export function parseFile() {}\nexport function parse() {}\n");
	// Tie-break fixtures: same exact name in a long path and a short path.
	write("a/b/c/deeper/long.ts", "export function safeThing() {}\n");
	write("x.ts", "export const safeThing = () => 1;\n");
	// Equal-length paths: lexicographic path order decides.
	write("k2.ts", "export function twinName() {}\n");
	write("k1.ts", "export function twinName() {}\n");
	// Case: exact case-sensitive match beats a case-insensitive exact match.
	write("case.ts", "export class Widget {}\nexport function widget() {}\n");
	// Limit: 30 substring matches in an early file, the exact one buried deep.
	const many = Array.from({ length: 30 }, (_, i) => `export function preTargetPost${i}() {}`);
	write("aaa.ts", `${many.join("\n")}\n`);
	write("zzz/deep/nested/place.ts", "export function Target() {}\nexport class TargetBox {}\n");
	// Kinds filter.
	write("kinds.ts", "export class Kindly {}\nexport function kindlyFn() {}\n");
	// Signature-only match (argument name, not symbol name).
	write("sig.ts", "export function holder(needleArg: string) { return needleArg; }\n");

	const index = await indexFolder(root);
	repoId = index.id;
});

afterAll(() => {
	clearIndex(repoId);
	fs.rmSync(root, { recursive: true, force: true });
});

describe("rank helpers", () => {
	test("camelTokens splits camel, Pascal, snake, digits and acronyms", () => {
		expect(camelTokens("systemOneGate")).toEqual(["system", "One", "Gate"]);
		expect(camelTokens("RepoMapper")).toEqual(["Repo", "Mapper"]);
		expect(camelTokens("parse_ts_file")).toEqual(["parse", "ts", "file"]);
		expect(camelTokens("HTTPServer2")).toEqual(["HTTP", "Server", "2"]);
	});

	test("matchTier: exact < prefix < camel token < substring < no match", () => {
		expect(matchTier("parse", "parse")).toBe(0);
		expect(matchTier("Parse", "parse")).toBe(0);
		expect(matchTier("parseFile", "parse")).toBe(1);
		expect(matchTier("fileParse", "parse")).toBe(2);
		expect(matchTier("systemOneGate", "OneGate")).toBe(2);
		expect(matchTier("reparse", "parse")).toBe(3);
		expect(matchTier("other", "parse")).toBeNull();
		expect(matchTier("anything", "")).toBeNull();
	});
});

describe("searchSymbols ranking", () => {
	test("exact, then prefix, then camel token, then substring", () => {
		const names = searchSymbols(repoId, "parse").map((s) => s.name);
		expect(names).toEqual(["parse", "parseFile", "fileParse", "reparse"]);
	});

	test("ties on tier break to the shorter path", () => {
		const hits = searchSymbols(repoId, "safeThing");
		expect(hits).toHaveLength(2);
		expect(path.relative(root, hits[0].filePath)).toBe("x.ts");
		expect(path.relative(root, hits[1].filePath)).toBe(
			path.join("a", "b", "c", "deeper", "long.ts"),
		);
	});

	test("equal-length paths break by path order, independent of index order", () => {
		const hits = searchSymbols(repoId, "twinName");
		expect(hits.map((s) => path.relative(root, s.filePath))).toEqual(["k1.ts", "k2.ts"]);
	});

	test("case-sensitive exact beats case-insensitive exact", () => {
		expect(searchSymbols(repoId, "widget")[0].name).toBe("widget");
		expect(searchSymbols(repoId, "Widget")[0].name).toBe("Widget");
	});

	test("limit applies after ranking, so a buried exact match still ranks first", () => {
		const hits = searchSymbols(repoId, "Target", { limit: 20 });
		expect(hits).toHaveLength(20);
		expect(hits[0].name).toBe("Target");
		expect(hits[1].name).toBe("TargetBox");
	});

	test("kinds filter keeps only the requested kinds", () => {
		const hits = searchSymbols(repoId, "kindly", { kinds: ["class"] });
		expect(hits.map((s) => s.name)).toEqual(["Kindly"]);
	});

	test("signature matches rank last and can be turned off", () => {
		expect(searchSymbols(repoId, "needleArg").map((s) => s.name)).toEqual(["holder"]);
		expect(searchSymbols(repoId, "needleArg", { matchSignature: false })).toEqual([]);
	});

	test("results are deterministic across calls", () => {
		const a = searchSymbols(repoId, "e").map((s) => s.id);
		const b = searchSymbols(repoId, "e").map((s) => s.id);
		expect(a).toEqual(b);
	});
});

describe("ensureIndexed", () => {
	test("concurrent and repeat calls share one build per folder", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ast-index-shared-"));
		fs.writeFileSync(path.join(dir, "one.ts"), "export function onlyOne() {}\n");
		try {
			const p1 = ensureIndexed(dir);
			const p2 = ensureIndexed(`${dir}${path.sep}`);
			expect(p1).toBe(p2);
			const [i1, i2] = await Promise.all([p1, p2]);
			expect(i1).toBe(i2);
			const i3 = await ensureIndexed(dir);
			expect(i3).toBe(i1);
			expect(i1.symbolCount).toBe(1);
			clearIndex(i1.id);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a cleared index is rebuilt on the next call", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ast-index-rebuild-"));
		fs.writeFileSync(path.join(dir, "one.ts"), "export function onlyOne() {}\n");
		try {
			const first = await ensureIndexed(dir);
			clearIndex(first.id);
			const second = await ensureIndexed(dir);
			expect(second).not.toBe(first);
			expect(searchSymbols(second.id, "onlyOne")).toHaveLength(1);
			clearIndex(second.id);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("getFreshFileOutline", () => {
	test("returns the indexed outline for an unchanged file", () => {
		const outline = getFreshFileOutline(repoId, "tiers2.ts");
		expect(outline?.symbols.map((s) => s.name)).toEqual(["parseFile", "parse"]);
	});

	test("returns null for a file the index does not hold", () => {
		expect(getFreshFileOutline(repoId, "not-there.ts")).toBeNull();
		expect(getFreshFileOutline("no-such-repo", "tiers2.ts")).toBeNull();
	});

	test("a file created after the build is not in the index (caller parses it)", () => {
		const rel = "created-later.ts";
		write(rel, "export function createdLater() {}\n");
		expect(getFreshFileOutline(repoId, rel)).toBeNull();
	});

	test("a stale indexed file is refreshed in place", () => {
		const rel = "tiers.ts";
		write(
			rel,
			"export function reparse() {}\nexport function fileParse() {}\nexport function addedLater() {}\n",
		);
		const future = new Date(Date.now() + 60_000);
		fs.utimesSync(path.join(root, rel), future, future);

		const outline = getFreshFileOutline(repoId, rel);
		expect(outline?.symbols.map((s) => s.name)).toContain("addedLater");
		expect(searchSymbols(repoId, "addedLater").map((s) => s.name)).toEqual(["addedLater"]);
	});

	test("a deleted indexed file drops out of the index", () => {
		const rel = "sig.ts";
		fs.rmSync(path.join(root, rel));
		expect(getFreshFileOutline(repoId, rel)).toBeNull();
		expect(searchSymbols(repoId, "holder")).toEqual([]);
	});
});

describe("query hygiene", () => {
	test("a blank or punctuation-only query matches nothing", () => {
		expect(searchSymbols(repoId, " ")).toEqual([]);
		expect(searchSymbols(repoId, "\t\n")).toEqual([]);
		expect(searchSymbols(repoId, "(")).toEqual([]);
		expect(searchSymbols(repoId, ": ")).toEqual([]);
	});

	test("surrounding whitespace is ignored", () => {
		expect(searchSymbols(repoId, "  parse  ")[0]?.name).toBe("parse");
	});
});

describe("repo identity", () => {
	test("two folders with the same basename are separate indexes", async () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "ast-index-twins-"));
		const a = path.join(base, "a", "app");
		const b = path.join(base, "b", "app");
		fs.mkdirSync(a, { recursive: true });
		fs.mkdirSync(b, { recursive: true });
		fs.writeFileSync(path.join(a, "x.ts"), "export function alpha() {}\n");
		fs.writeFileSync(
			path.join(b, "x.ts"),
			"\nexport function beta() {}\nexport function gamma() {}\n",
		);
		try {
			const ia = await ensureIndexed(a);
			const ib = await ensureIndexed(b);
			expect(ia.id).not.toBe(ib.id);
			expect(ia.sourceRoot).toBe(a);
			expect(searchSymbols(ia.id, "alpha").map((s) => s.filePath)).toEqual([path.join(a, "x.ts")]);
			expect(searchSymbols(ia.id, "beta")).toEqual([]);
			expect(searchSymbols(ib.id, "beta").map((s) => s.filePath)).toEqual([path.join(b, "x.ts")]);
			expect(getFreshFileOutline(ia.id, "x.ts")?.symbols.map((s) => s.name)).toEqual(["alpha"]);
			// Building B did not evict A, so A is not rebuilt.
			expect(await ensureIndexed(a)).toBe(ia);
			clearIndex(ia.id);
			clearIndex(ib.id);
		} finally {
			fs.rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("refreshIndex", () => {
	test("picks up created, changed and deleted files", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ast-index-refresh-"));
		fs.writeFileSync(path.join(dir, "keep.ts"), "export function keepMe() {}\n");
		fs.writeFileSync(path.join(dir, "gone.ts"), "export function goneSoon() {}\n");
		fs.mkdirSync(path.join(dir, "node_modules"));
		try {
			const index = await indexFolder(dir);
			fs.writeFileSync(
				path.join(dir, "keep.ts"),
				"export function keepMe() {}\nexport function grewHere() {}\n",
			);
			const future = new Date(Date.now() + 60_000);
			fs.utimesSync(path.join(dir, "keep.ts"), future, future);
			fs.writeFileSync(path.join(dir, "fresh.ts"), "export function brandNew() {}\n");
			fs.writeFileSync(
				path.join(dir, "node_modules", "dep.ts"),
				"export function ignoredDep() {}\n",
			);
			fs.rmSync(path.join(dir, "gone.ts"));

			expect(refreshIndex(index.id)).toEqual({ added: 1, changed: 1, removed: 1 });
			expect(searchSymbols(index.id, "brandNew")).toHaveLength(1);
			expect(searchSymbols(index.id, "grewHere")).toHaveLength(1);
			expect(searchSymbols(index.id, "goneSoon")).toEqual([]);
			expect(searchSymbols(index.id, "ignoredDep")).toEqual([]);
			expect(index.fileCount).toBe(2);
			expect(index.symbolCount).toBe(3);
			// Nothing changed since: a second pass is a no-op.
			expect(refreshIndex(index.id)).toEqual({ added: 0, changed: 0, removed: 0 });
			expect(refreshIndex("no-such-repo")).toBeNull();
			clearIndex(index.id);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("refreshIndexAsync", () => {
	test("gives the same result as refreshIndex and yields to the event loop", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ast-index-refresh-async-"));
		for (let i = 0; i < 120; i++) {
			fs.writeFileSync(path.join(dir, `f${i}.ts`), `export function f${i}() {}\n`);
		}
		try {
			const index = await indexFolder(dir);
			const future = new Date(Date.now() + 60_000);
			for (let i = 0; i < 120; i++) {
				fs.writeFileSync(path.join(dir, `f${i}.ts`), `export function g${i}() {}\n`);
				fs.utimesSync(path.join(dir, `f${i}.ts`), future, future);
			}
			fs.writeFileSync(path.join(dir, "fresh.ts"), "export function brandNew() {}\n");
			let ticked = false;
			setImmediate(() => {
				ticked = true;
			});
			const pending = refreshIndexAsync(index.id);
			expect(ticked).toBe(false);
			expect(await pending).toEqual({ added: 1, changed: 120, removed: 0 });
			expect(ticked).toBe(true);
			expect(searchSymbols(index.id, "g7")[0]?.name).toBe("g7");
			expect(searchSymbols(index.id, "brandNew")).toHaveLength(1);
			// Two callers at once share one pass.
			const [a, b] = [refreshIndexAsync(index.id), refreshIndexAsync(index.id)];
			expect(a).toBe(b);
			expect(await a).toEqual({ added: 0, changed: 0, removed: 0 });
			expect(await refreshIndexAsync("no-such-repo")).toBeNull();
			clearIndex(index.id);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("indexFolder", () => {
	test("yields to the event loop while building", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ast-index-yield-"));
		for (let i = 0; i < 120; i++) {
			fs.writeFileSync(path.join(dir, `f${i}.ts`), `export function f${i}() {}\n`);
		}
		try {
			let ticked = false;
			setImmediate(() => {
				ticked = true;
			});
			const index = await indexFolder(dir);
			expect(ticked).toBe(true);
			expect(index.symbolCount).toBe(120);
			clearIndex(index.id);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a folder with no TypeScript or JavaScript indexes to zero symbols", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ast-index-py-"));
		fs.writeFileSync(path.join(dir, "main.py"), "def py_only():\n    pass\n");
		try {
			const index = await indexFolder(dir);
			expect(index.symbolCount).toBe(0);
			expect(searchSymbols(index.id, "py_only")).toEqual([]);
			clearIndex(index.id);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
