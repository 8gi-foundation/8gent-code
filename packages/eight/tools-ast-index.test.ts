/**
 * ToolExecutor code-exploration tools read the shared AST index.
 *
 * search_symbols used to re-glob and parse only the first 50 files, so a
 * symbol in file 51+ was invisible. These fixtures put the target past that
 * cap and check the ranked index answers instead, that every executor on one
 * folder shares a single build, and that get_outline / get_symbol stay correct
 * for files edited or created after the build.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearIndex, ensureIndexed } from "../ast-index";
import { ToolExecutor } from "./tools";

let root: string;
let executor: ToolExecutor;

function write(rel: string, content: string): void {
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
}

type Match = { name: string; kind: string; file: string; line: number };

async function search(query: string, kinds?: string[]): Promise<Match[]> {
	const out = await executor.execute("search_symbols", kinds ? { query, kinds } : { query });
	return (JSON.parse(out) as { matches: Match[] }).matches;
}

beforeAll(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "tools-ast-index-"));
	// 60 filler files sort before the target, each with a substring decoy.
	for (let i = 0; i < 60; i++) {
		write(`a${String(i).padStart(2, "0")}.ts`, `export function makeWidgetGate${i}() {}\n`);
	}
	write("z/deep/gate.ts", "// header\n\nexport function widgetGate(x: number) {\n\treturn x;\n}\n");
	write("z/edit.ts", "export function beforeEdit() {}\n");
	executor = new ToolExecutor(root);
	await ensureIndexed(root);
});

afterAll(() => {
	clearIndex(root);
	fs.rmSync(root, { recursive: true, force: true });
});

describe("search_symbols", () => {
	test("finds a definition past the old 50-file cap and ranks the exact name first", async () => {
		const matches = await search("widgetGate");
		expect(matches[0]).toEqual({
			name: "widgetGate",
			kind: "function",
			file: path.join("z", "deep", "gate.ts"),
			line: 3,
		});
		expect(matches.length).toBe(20);
	});

	test("kinds filter is honoured", async () => {
		expect(await search("widgetGate", ["class"])).toEqual([]);
	});

	test("every executor on one folder shares the single index build", async () => {
		const first = await ensureIndexed(root);
		const second = new ToolExecutor(root);
		// A second build would produce a new RepoIndex object; sharing returns the same one.
		// biome-ignore lint/suspicious/noExplicitAny: reading the private promise is the point of this test
		expect(await (executor as any).astIndexPromise).toBe(first);
		// biome-ignore lint/suspicious/noExplicitAny: same as above
		expect(await (second as any).astIndexPromise).toBe(first);
	});
});

describe("get_outline / get_symbol", () => {
	test("get_outline returns the indexed outline", async () => {
		const out = JSON.parse(await executor.execute("get_outline", { filePath: "z/deep/gate.ts" }));
		expect(out.symbolCount).toBe(1);
		expect(out.symbols[0]).toMatchObject({ name: "widgetGate", kind: "function", lines: "3-5" });
	});

	test("get_symbol returns source for an indexed symbol", async () => {
		const out = await executor.execute("get_symbol", { symbolId: "z/deep/gate.ts::widgetGate" });
		expect(out).toContain("// Lines 3-5");
		expect(out).toContain("export function widgetGate(x: number)");
	});

	test("an edited file is re-read, and search sees the new symbol", async () => {
		write("z/edit.ts", "export function beforeEdit() {}\nexport function afterEdit() {}\n");
		const future = new Date(Date.now() + 60_000);
		fs.utimesSync(path.join(root, "z/edit.ts"), future, future);
		const out = JSON.parse(await executor.execute("get_outline", { filePath: "z/edit.ts" }));
		expect(out.symbols.map((s: { name: string }) => s.name)).toEqual(["beforeEdit", "afterEdit"]);
		expect((await search("afterEdit"))[0]?.name).toBe("afterEdit");
	});

	test("search sees a symbol added to a file that was never a hit, with no get_outline first", async () => {
		write("z/quiet.ts", "export function quietOne() {}\n");
		expect((await search("quietOne"))[0]?.name).toBe("quietOne");
		write("z/quiet.ts", "export function quietOne() {}\nexport function loudTwo() {}\n");
		const future = new Date(Date.now() + 120_000);
		fs.utimesSync(path.join(root, "z/quiet.ts"), future, future);
		expect(await search("loudTwo")).toEqual([
			{ name: "loudTwo", kind: "function", file: path.join("z", "quiet.ts"), line: 2 },
		]);
	});

	test("search finds a file created after the build, and forgets a deleted one", async () => {
		write("made/new.ts", "export function delta() {}\n");
		expect(await search("delta")).toEqual([
			{ name: "delta", kind: "function", file: path.join("made", "new.ts"), line: 1 },
		]);
		fs.rmSync(path.join(root, "made/new.ts"));
		expect(await search("delta")).toEqual([]);
	});

	test("a blank query returns no matches", async () => {
		expect(await search(" ")).toEqual([]);
	});

	test("a file created after the build falls back to parsing", async () => {
		write("late.ts", "export class LateComer {}\n");
		const out = JSON.parse(await executor.execute("get_outline", { filePath: "late.ts" }));
		expect(out.symbols[0]).toMatchObject({ name: "LateComer", kind: "class" });
		const sym = await executor.execute("get_symbol", { symbolId: "late.ts::LateComer" });
		expect(sym).toContain("export class LateComer");
	});

	test("a missing file still reports not found", async () => {
		expect(await executor.execute("get_outline", { filePath: "nope.ts" })).toContain(
			"File not found",
		);
	});
});

describe("isolation and non-TS repos", () => {
	test("executors on two folders with the same basename each read their own repo", async () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "tools-ast-twins-"));
		const a = path.join(base, "a", "app");
		const b = path.join(base, "b", "app");
		fs.mkdirSync(a, { recursive: true });
		fs.mkdirSync(b, { recursive: true });
		fs.writeFileSync(path.join(a, "x.ts"), "export function alpha() {}\n");
		fs.writeFileSync(
			path.join(b, "x.ts"),
			"\n\nexport function beta() {}\nexport function gamma() {}\n",
		);
		try {
			const ea = new ToolExecutor(a);
			const eb = new ToolExecutor(b);
			await Promise.all([ensureIndexed(a), ensureIndexed(b)]);
			const outA = JSON.parse(await ea.execute("get_outline", { filePath: "x.ts" }));
			expect(outA.symbols.map((s: { name: string }) => s.name)).toEqual(["alpha"]);
			const symA = await ea.execute("get_symbol", { symbolId: "x.ts::alpha" });
			expect(symA).toContain("// Lines 1-1");
			expect(symA).toContain("export function alpha()");
			const find = async (e: ToolExecutor, q: string) =>
				(JSON.parse(await e.execute("search_symbols", { query: q })) as { matches: Match[] })
					.matches;
			expect((await find(ea, "alpha")).map((m) => m.file)).toEqual(["x.ts"]);
			expect(await find(ea, "beta")).toEqual([]);
			expect((await find(eb, "beta")).map((m) => m.file)).toEqual(["x.ts"]);
			clearIndex(a);
			clearIndex(b);
		} finally {
			fs.rmSync(base, { recursive: true, force: true });
		}
	});

	test("a repo with no TS/JS files answers search with no matches, not an error", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tools-ast-py-"));
		fs.writeFileSync(path.join(dir, "main.py"), "def py_only():\n    pass\n");
		try {
			const e = new ToolExecutor(dir);
			await ensureIndexed(dir);
			const out = JSON.parse(await e.execute("search_symbols", { query: "py_only" }));
			expect(out).toEqual({ query: "py_only", matches: [] });
			clearIndex(dir);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
