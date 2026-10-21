import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validatePath } from "../../permissions/path-guard";
import {
	MAX_GITIGNORE_RULES,
	formatSearch,
	globMatcher,
	parseGitignore,
	searchFiles,
} from "../inproc-search";

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
	put("credentials", "needle credentials\n");
	put(".ssh/id_rsa", "needle ssh key\n");
	put(".8gent/secrets/x", "needle secret\n");
	put("docs/readme.md", "No match here.\n");
});
// The workspace is the home dir here (the real exposure: ~/.ssh, ~/.8gent/secrets).
const guard = (abs: string) => validatePath(abs, root, { home: root }, "read").ok;
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("inproc-search", () => {
	test("literal grep: exact rows, sorted, posix paths, ignore rules, binary skipped", async () => {
		const r = await searchFiles({ root, allow: guard, pattern: "needle" });
		expect(formatSearch(r).split("\n")).toEqual([
			"keep.log:1:needle kept",
			"src/a.ts:1:export const needle = 1;",
			"src/a.ts:3:let Needle2 = 3;",
			"src/deep/b.ts:1:// needle in b",
		]);
		expect(r.truncated).toBe(false);
	});

	test("smart case: a capital makes it case-sensitive", async () => {
		const r = await searchFiles({ root, allow: guard, pattern: "Needle" });
		expect(r.hits.map((h) => `${h.file}:${h.line}`)).toEqual(["src/a.ts:3"]);
	});

	test("the pattern is plain text: regex characters match themselves; glob filter; CRLF stripped", async () => {
		expect((await searchFiles({ root, allow: guard, pattern: "const \\w+" })).hits).toEqual([]);
		const r = await searchFiles({ root, allow: guard, pattern: "const ", glob: "*.ts" });
		expect(r.hits.map((h) => `${h.file}:${h.line}`)).toEqual(["src/a.ts:1", "src/a.ts:2"]);
		expect(r.hits[1].text).toBe("const other = 2;");
	});

	test("file listing respects ignores", async () => {
		const r = await searchFiles({ root, allow: guard });
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
		const r = await searchFiles({ root, allow: guard, pattern: "needle", maxResults: 2 });
		expect(r.hits.length).toBe(2);
		expect(r.truncated).toBe(true);
		expect(formatSearch(r)).toContain("[truncated");
	});

	test("no match", async () => {
		expect(formatSearch(await searchFiles({ root, allow: guard, pattern: "zzzzqq" }))).toBe(
			"No matches.",
		);
	});

	test("globMatcher", async () => {
		const m = (g: string, p: string, anchored = true) =>
			(globMatcher(g, anchored) as (r: string) => boolean)(p);
		expect(m("src/**/*.ts", "src/deep/b.ts")).toBe(true);
		expect(m("src/**/*.ts", "src/a.ts")).toBe(true);
		expect(m("src/**", "src/deep/b.ts")).toBe(true);
		expect(m("*.ts", "src/a.ts", false)).toBe(true);
		expect(m("*.ts", "src/a.ts")).toBe(false);
		expect(m("a?c", "abc")).toBe(true);
		expect(m("a*c", "abxc")).toBe(true);
		expect(m("a*c", "abxd")).toBe(false);
	});

	test("hostile glob returns fast: refused when over the caps, linear when under", async () => {
		const evilName = `${"a".repeat(40)}`;
		const d = path.join(root, "evilglob");
		fs.mkdirSync(d);
		fs.writeFileSync(path.join(d, evilName), "x\n");
		const t0 = Date.now();
		// 15 wildcards: over the cap, refused
		const over = await searchFiles({ root: d, glob: `${"*a".repeat(15)}*b`, allow: guard });
		expect(formatSearch(over)).toContain("Search refused");
		// 8 wildcards: allowed, and the matcher has no exponential path
		const under = await searchFiles({ root: d, glob: `${"*a".repeat(7)}*b`, allow: guard });
		expect(under.files).toEqual([]);
		expect(await searchFiles({ root: d, allow: () => true, glob: "a".repeat(300) })).toMatchObject({
			error: expect.any(String),
		});
		expect(Date.now() - t0).toBeLessThan(6000);
	});

	test("hostile .gitignore rule cannot hang the walk", async () => {
		const d = path.join(root, "evilignore");
		fs.mkdirSync(d);
		fs.writeFileSync(path.join(d, ".gitignore"), `${"*a".repeat(15)}*b\n${"*a".repeat(7)}*b\n`);
		fs.writeFileSync(path.join(d, "a".repeat(40)), "needle\n");
		const t0 = Date.now();
		const r = await searchFiles({ root: d, pattern: "needle", allow: guard });
		expect(Date.now() - t0).toBeLessThan(6000);
		expect(r.hits.length).toBe(1);
	});

	test("path-guard: credentials, .ssh and .8gent/secrets are never walked or returned", async () => {
		const r = await searchFiles({ root, allow: guard, pattern: "needle" });
		const seen = r.hits.map((h) => h.file).join(" ");
		for (const denied of ["credentials", "id_rsa", "secrets"]) expect(seen).not.toContain(denied);
		expect(formatSearch(r)).not.toMatch(/ssh key|needle secret|needle credentials/);
		const list = await searchFiles({ root, allow: guard });
		expect(list.files.join(" ")).not.toMatch(/credentials|id_rsa|secrets/);
		// the guard is what hides them: the same walk without it finds all three
		const open = await searchFiles({ root, allow: () => true, pattern: "needle" });
		expect(open.hits.map((h) => h.file)).toEqual(
			expect.arrayContaining(["credentials", ".ssh/id_rsa", ".8gent/secrets/x"]),
		);
	});

	test("walk entry cap truncates", async () => {
		const r = await searchFiles({ root, allow: guard, maxEntries: 3 });
		expect(r.truncated).toBe(true);
	});

	test("works inside a bun --compile binary (no worker)", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "inproc-compile-"));
		try {
			fs.mkdirSync(path.join(d, "tree"));
			fs.writeFileSync(path.join(d, "tree", "f.txt"), "hello compiled needle\n");
			const entry = path.join(d, "entry.ts");
			const mod = path
				.join(import.meta.dir, "..", "inproc-search.ts")
				.split(path.sep)
				.join("/");
			fs.writeFileSync(
				entry,
				`import { searchFiles } from ${JSON.stringify(mod)};\nconst r = await searchFiles({ root: process.argv[2], allow: () => true, pattern: "needle" });\nconsole.log(JSON.stringify({ hits: r.hits, error: r.error }));\n`,
			);
			const exe = path.join(d, process.platform === "win32" ? "e.exe" : "e");
			const build = Bun.spawnSync(
				[process.execPath, "build", "--compile", entry, "--outfile", exe],
				{ cwd: d },
			);
			expect(build.exitCode).toBe(0);
			const run = Bun.spawnSync([exe, path.join(d, "tree")]);
			expect(JSON.parse(run.stdout.toString().trim().split("\n").pop() as string)).toEqual({
				hits: [{ file: "f.txt", line: 1, text: "hello compiled needle" }],
			});
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	}, 120000);

	test("searchFiles starts no Worker and no child process", async () => {
		const g = globalThis as unknown as { Worker: unknown };
		const realWorker = g.Worker;
		let made = 0;
		g.Worker = class {
			constructor() {
				made++;
			}
		};
		const cp = await import("node:child_process");
		const spawnSpy = spyOn(cp, "spawn");
		try {
			await searchFiles({ root, allow: guard, pattern: "needle" });
		} finally {
			g.Worker = realWorker;
		}
		expect(made).toBe(0);
		expect(spawnSpy).not.toHaveBeenCalled();
		spawnSpy.mockRestore();
	});

	test("gitignore matcher agrees with git on classes, escapes and anchors", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "inproc-git-"));
		try {
			const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: d }).stdout.toString();
			git("init", "-q");
			const rules = [
				"[ab].txt",
				"\\#hash",
				"sp\\ ace",
				"!keep.tmp",
				"*.tmp",
				"/top.md",
				"doc/**/x.md",
				"[!c]d.log",
				"build/",
				"?q",
			];
			fs.writeFileSync(path.join(d, ".gitignore"), `${rules.join("\n")}\n`);
			const names = [
				"a.txt",
				"b.txt",
				"c.txt",
				"#hash",
				"sp ace",
				"keep.tmp",
				"z.tmp",
				"top.md",
				"sub/top.md",
				"doc/x.md",
				"doc/a/b/x.md",
				"doc/y.md",
				"ad.log",
				"cd.log",
				"zq",
				"zzq",
				"build/o.js",
				"src/build/o.js",
				"plain.ts",
			];
			for (const n of names) {
				fs.mkdirSync(path.dirname(path.join(d, n)), { recursive: true });
				fs.writeFileSync(path.join(d, n), "x\n");
			}
			const gitSays = git("ls-files", "--others", "--exclude-standard")
				.split("\n")
				.filter(Boolean)
				.sort();
			const ours = (await searchFiles({ root: d, allow: () => true })).files.sort();
			expect(ours).toEqual(gitSays);
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("a 200 KB blank .gitignore line is dropped fast, not quadratic", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "inproc-gi-"));
		try {
			fs.writeFileSync(path.join(d, ".gitignore"), `${" ".repeat(200_000)}x\n`);
			fs.writeFileSync(path.join(d, "f.txt"), "needle\n");
			const t0 = performance.now();
			const r = await searchFiles({ root: d, allow: () => true, pattern: "needle" });
			expect(performance.now() - t0).toBeLessThan(100);
			expect(r.hits.length).toBe(1);
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("a huge .gitignore is read to 1 MB and keeps at most 10,000 rules", async () => {
		const rules = parseGitignore(
			`${Array.from({ length: 200_000 }, (_, i) => `r${i}.tmp`).join("\n")}\n`,
		);
		expect(rules.length).toBe(MAX_GITIGNORE_RULES);
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "inproc-gi2-"));
		try {
			fs.writeFileSync(
				path.join(d, ".gitignore"),
				`${Array.from({ length: 200_000 }, (_, i) => `r${i}.tmp`).join("\n")}\n`,
			);
			for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(d, `f${i}.txt`), "needle\n");
			const t0 = performance.now();
			const r = await searchFiles({
				root: d,
				allow: () => true,
				pattern: "needle",
				maxResults: 1000,
			});
			expect(performance.now() - t0).toBeLessThan(3000);
			expect(r.hits.length).toBe(300);
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("rule budget is per search, not per .gitignore", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "inproc-nest-"));
		try {
			const rules = `${Array.from({ length: MAX_GITIGNORE_RULES }, (_, i) => `r${i}.tmp`).join("\n")}\n`;
			let dir = d;
			for (let i = 0; i < 60; i++) {
				fs.writeFileSync(path.join(dir, ".gitignore"), rules);
				dir = path.join(dir, `n${i}`);
				fs.mkdirSync(dir);
			}
			for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), "needle\n");
			const t0 = performance.now();
			const r = await searchFiles({
				root: d,
				allow: () => true,
				pattern: "needle",
				maxResults: 1000,
			});
			expect(performance.now() - t0).toBeLessThan(1000);
			expect(r.hits.length).toBe(300);
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("reversed class range [z-a] matches its start char, as in git", () => {
		const m = globMatcher("[z-a].txt", false);
		expect(m?.("z.txt")).toBe(true);
		expect(m?.("m.txt")).toBe(false);
		expect(m?.("a.txt")).toBe(false);
	});

	test("spawns nothing", async () => {
		const src = fs.readFileSync(path.join(import.meta.dir, "..", "inproc-search.ts"), "utf8");
		expect(src).not.toMatch(/child_process|Worker|execSync|spawnSync|Bun\.spawn/);
	});
});
