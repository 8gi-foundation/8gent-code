import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatSearch, globToRegExp, searchFiles } from "../inproc-search";

// A fixed fixture tree, built the same way on every host. CI runs this on
// Linux and Windows (platforms.yml); the expected rows are literal, so any
// host difference (separators, CRLF, walk order, ignore handling) fails.
let root: string;
const put = (rel: string, body: string | Buffer) => {
	const full = path.join(root, ...rel.split("/"));
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, body);
};

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "inproc-search-"));
	put(".gitignore", "build/\n*.log\n!keep.log\n# comment\n");
	put("src/a.ts", "export const needle = 1;\nconst other = 2;\r\nlet Needle2 = 3;\n");
	put("src/deep/b.ts", "// needle in b\n");
	put("src/deep/.gitignore", "secret.ts\n");
	put("src/deep/secret.ts", "needle hidden\n");
	put("build/out.js", "needle built\n");
	put("trace.log", "needle logged\n");
	put("keep.log", "needle kept\n");
	put("node_modules/pkg/i.js", "needle dep\n");
	put("bin.dat", Buffer.from([110, 101, 101, 100, 108, 101, 0, 1, 2]));
	put("docs/readme.md", "No match here.\n");
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("inproc-search", () => {
	test("literal grep: exact rows, sorted, posix paths, ignore rules, binary skipped", async () => {
		const r = await searchFiles({ root, pattern: "needle", literal: true });
		expect(formatSearch(r).split("\n")).toEqual([
			"keep.log:1:needle kept",
			"src/a.ts:1:export const needle = 1;",
			"src/a.ts:3:let Needle2 = 3;",
			"src/deep/b.ts:1:// needle in b",
		]);
		expect(r.truncated).toBe(false);
	});

	test("smart case: a capital makes it case-sensitive", async () => {
		const r = await searchFiles({ root, pattern: "Needle", literal: true });
		expect(r.hits.map((h) => `${h.file}:${h.line}`)).toEqual(["src/a.ts:3"]);
	});

	test("regex and glob filter", async () => {
		const r = await searchFiles({ root, pattern: "const \\w+ = \\d", glob: "*.ts" });
		expect(r.hits.map((h) => `${h.file}:${h.line}`)).toEqual(["src/a.ts:1", "src/a.ts:2"]);
		expect(r.hits[1].text).toBe("const other = 2;"); // CRLF stripped
	});

	test("file listing respects ignores", async () => {
		const r = await searchFiles({ root });
		expect(r.files).toEqual([
			".gitignore",
			"bin.dat",
			"docs/readme.md",
			"keep.log",
			"src/a.ts",
			"src/deep/.gitignore",
			"src/deep/b.ts",
		]);
	});

	test("result cap sets truncated", async () => {
		const r = await searchFiles({ root, pattern: "needle", maxResults: 2 });
		expect(r.hits.length).toBe(2);
		expect(r.truncated).toBe(true);
		expect(formatSearch(r)).toContain("[truncated");
	});

	test("no match", async () => {
		expect(formatSearch(await searchFiles({ root, pattern: "zzzzqq" }))).toBe("No matches.");
	});

	test("globToRegExp", async () => {
		expect(globToRegExp("src/**/*.ts").test("src/deep/b.ts")).toBe(true);
		expect(globToRegExp("src/**/*.ts").test("src/a.ts")).toBe(true);
		expect(globToRegExp("*.ts", false).test("src/a.ts")).toBe(true);
		expect(globToRegExp("*.ts").test("src/a.ts")).toBe(false);
	});

	test("spawns nothing", async () => {
		const src = fs.readFileSync(path.join(import.meta.dir, "..", "inproc-search.ts"), "utf8");
		expect(src).not.toMatch(/from "node:child_process"|require\(|execSync|spawnSync|Bun\.spawn/);
	});
});
