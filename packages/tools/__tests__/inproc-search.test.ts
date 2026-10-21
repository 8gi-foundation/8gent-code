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
			expect(r.hits.length).toBe(0); // over the cap: the walk stops, it does not list unfiltered
			expect(r.rulesIncomplete).toBeDefined();
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("rule budget is per search; nested .gitignore past it stops the walk", async () => {
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
			expect(performance.now() - t0).toBeLessThan(2000);
			expect(r.hits.length).toBe(0); // the second .gitignore cannot be read: stop, not unfiltered
			expect(r.rulesIncomplete).toBeDefined();
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

	test("matching work is capped per search: wide tree, 10k wildcard rules", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "inproc-wide-"));
		try {
			fs.writeFileSync(
				path.join(d, ".gitignore"),
				`${Array.from({ length: MAX_GITIGNORE_RULES }, (_, i) => `*${i}[a-z]*[!q]?x`).join("\n")}\n`,
			);
			for (let k = 0; k < 20; k++) {
				fs.mkdirSync(path.join(d, `d${k}`));
				for (let i = 0; i < 300; i++)
					fs.writeFileSync(path.join(d, `d${k}`, `f${i}.txt`), "needle\n");
			}
			const t0 = performance.now();
			const r = await searchFiles({
				root: d,
				allow: () => true,
				pattern: "zzqq",
				maxResults: 1000,
			});
			expect(performance.now() - t0).toBeLessThan(3000);
			expect(r.truncated).toBe(true);
			expect(r.rulesIncomplete).toBeDefined();
			expect(formatSearch(r)).toContain("[ignore rules incomplete:");
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	const base = { hits: [], files: [], filesScanned: 0, truncated: true };
	const NOTE = {
		capped: "[truncated: showing first 2 matches. Narrow the pattern or glob to see the rest.]",
		rules:
			"[ignore rules incomplete: search stopped after 7 files because .gitignore rules exceeded the limit. Results so far are shown. Add a glob to narrow the search.]",
		deadline:
			"[stopped after 2s: searched 5 of 9 files. Results so far are shown. Narrow the pattern or glob to search the rest.]",
		deadlineNoTotal:
			"[stopped after 2s: searched 5 files. Results so far are shown. Narrow the pattern or glob to search the rest.]",
	};
	const hit = { file: "a.ts", line: 1, text: "x" };

	test("formatSearch prints each state exactly, one line per state", () => {
		const two = [hit, { ...hit, line: 2 }];
		expect(formatSearch({ ...base, hits: two, capped: true })).toBe(
			`a.ts:1:x\na.ts:2:x\n${NOTE.capped}`,
		);
		expect(formatSearch({ ...base, hits: [hit], rulesIncomplete: { filesWalked: 7 } })).toBe(
			`a.ts:1:x\n${NOTE.rules}`,
		);
		expect(
			formatSearch({ ...base, hits: [hit], deadline: { searched: 5, total: 9, seconds: 2 } }),
		).toBe(`a.ts:1:x\n${NOTE.deadline}`);
		expect(formatSearch({ ...base, hits: [hit], deadline: { searched: 5, seconds: 2 } })).toBe(
			`a.ts:1:x\n${NOTE.deadlineNoTotal}`,
		);
		expect(
			formatSearch({
				...base,
				hits: [hit],
				rulesIncomplete: { filesWalked: 7 },
				deadline: { searched: 5, seconds: 2 },
			}).split("\n"),
		).toEqual(["a.ts:1:x", NOTE.rules, NOTE.deadlineNoTotal]);
	});

	test("a zero-hit partial search never prints a bare No matches.", () => {
		const states = [
			{ rulesIncomplete: { filesWalked: 7 } },
			{ deadline: { searched: 5, total: 9, seconds: 2 } },
			{ entryCap: 200000 },
		];
		for (const st of states) {
			const out = formatSearch({ ...base, ...st });
			expect(out.split("\n")[0]).toBe("No matches in the part searched.");
			expect(out.split("\n").at(-1)).toBe(
				"This does not mean the pattern is absent from the repo.",
			);
			expect(out).not.toMatch(/^No matches\.$/m);
			expect(out).not.toContain("cap reached");
		}
		expect(formatSearch({ ...base, truncated: false })).toBe("No matches.");
	});

	test("10k ** rules over a wide tree: bounded time, never unfiltered, says so", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "inproc-deep-"));
		try {
			fs.writeFileSync(
				path.join(d, ".gitignore"),
				`${Array.from({ length: MAX_GITIGNORE_RULES }, (_, i) => `**/a${i}/**/b?x`).join("\n")}\n`,
			);
			for (let k = 0; k < 20; k++) {
				fs.mkdirSync(path.join(d, `d${k}`));
				for (let i = 0; i < 300; i++)
					fs.writeFileSync(path.join(d, `d${k}`, `f${i}.txt`), "needle\n");
			}
			const t0 = performance.now();
			const r = await searchFiles({
				root: d,
				allow: () => true,
				pattern: "needle",
				maxResults: 100000,
			});
			expect(performance.now() - t0).toBeLessThanOrEqual(4000);
			const out = formatSearch(r);
			expect(r.rulesIncomplete || r.deadline).toBeTruthy();
			expect(out).toMatch(/\[(ignore rules incomplete|stopped after 2s)/);
			expect(out).not.toContain("cap reached");
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("rule budget spent: the walk stops, no hit without the incomplete line", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "inproc-budget-"));
		try {
			fs.writeFileSync(
				path.join(d, ".gitignore"),
				`${Array.from({ length: MAX_GITIGNORE_RULES }, (_, i) => `*${i}[a-z]*[!q]?x`).join("\n")}\n`,
			);
			for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(d, `f${i}.txt`), "needle\n");
			const r = await searchFiles({
				root: d,
				allow: () => true,
				pattern: "needle",
				maxResults: 100000,
				deadlineMs: 60000,
			});
			expect(r.rulesIncomplete).toBeDefined();
			expect(r.hits.length).toBeGreaterThan(0);
			expect(r.hits.length).toBeLessThan(2000); // the walk stopped, it did not go on unfiltered
			expect(formatSearch(r)).toContain("[ignore rules incomplete: search stopped after");
			const none = await searchFiles({
				root: d,
				allow: () => true,
				pattern: "zzqq",
				maxResults: 100000,
				deadlineMs: 60000,
			});
			expect(formatSearch(none).startsWith("No matches in the part searched.")).toBe(true);
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("a tiny deadline returns partial results with the deadline line", async () => {
		const r = await searchFiles({ root, allow: () => true, pattern: "needle", deadlineMs: 0 });
		expect(r.deadline).toBeDefined();
		expect(formatSearch(r)).toContain("[stopped after 0s: searched 0 files");
	});

	test("over-cap .gitignore stops the walk: no ignored file is listed", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "inproc-over-"));
		try {
			fs.writeFileSync(
				path.join(d, ".gitignore"),
				`${Array.from({ length: MAX_GITIGNORE_RULES + 1 }, (_, i) => `r${i}.tmp`).join("\n")}\n`,
			);
			fs.mkdirSync(path.join(d, "sub", "build"), { recursive: true });
			fs.writeFileSync(path.join(d, "sub", ".gitignore"), "build/\n");
			fs.writeFileSync(path.join(d, "sub", "build", "out.txt"), "needle\n");
			fs.writeFileSync(path.join(d, "a.txt"), "needle\n");
			const r = await searchFiles({ root: d, allow: () => true, pattern: "needle" });
			expect(r.hits.some((h) => h.file.includes("build"))).toBe(false);
			expect(formatSearch(r)).toContain("[ignore rules incomplete: search stopped after");
			// a later .gitignore that cannot be read (budget spent exactly) stops the walk too
			fs.writeFileSync(
				path.join(d, ".gitignore"),
				`${Array.from({ length: MAX_GITIGNORE_RULES }, (_, i) => `r${i}.tmp`).join("\n")}\n`,
			);
			const r2 = await searchFiles({ root: d, allow: () => true, pattern: "needle" });
			expect(r2.hits.some((h) => h.file.includes("build"))).toBe(false);
			expect(r2.rulesIncomplete).toBeDefined();
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("a sparse file over maxFileBytes is never read and the deadline holds", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "inproc-sparse-"));
		try {
			for (let i = 0; i < 8; i++) {
				const fd = fs.openSync(path.join(d, `big${i}.bin.txt`), "w");
				fs.ftruncateSync(fd, 2_000_000_000);
				fs.closeSync(fd);
			}
			fs.writeFileSync(path.join(d, "small.txt"), "needle\n");
			const rss0 = process.memoryUsage().rss;
			const t0 = performance.now();
			const r = await searchFiles({
				root: d,
				allow: () => true,
				pattern: "needle",
				deadlineMs: 2000,
			});
			expect(performance.now() - t0).toBeLessThan(2000 + 1500);
			expect(process.memoryUsage().rss - rss0).toBeLessThan(500_000_000);
			expect(r.hits.map((h) => h.file)).toEqual(["small.txt"]);
			expect(r.filesScanned).toBe(1); // the big files were skipped by size, not scanned
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("deadline line counts entries in list mode and files in content mode", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "inproc-count-"));
		try {
			for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(d, `f${i}.txt`), "needle\n");
			// walk completes, then the clock is already out: content mode reports files scanned of the total
			const list = formatSearch({
				...base,
				files: ["a.txt"],
				deadline: { searched: 12, seconds: 2 },
			});
			expect(list).toContain("searched 12 files.");
			expect(
				formatSearch({
					...base,
					files: ["a.txt"],
					deadline: { searched: 12, seconds: 2, unit: "entries" },
				}),
			).toContain("searched 12 entries.");
			expect(list).not.toContain("searched 0 files");
			const c = await searchFiles({ root: d, allow: () => true, deadlineMs: 0 });
			expect(c.deadline?.searched).toBeGreaterThanOrEqual(0);
			const lm = await searchFiles({ root: d, allow: () => true, maxEntries: 10_000 });
			expect(lm.deadline).toBeUndefined();
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("rules-too-costly line is used when the rule-check budget is spent", async () => {
		const out = formatSearch({ ...base, rulesIncomplete: { filesWalked: 7, cause: "cost" } });
		expect(out).toContain(
			"[ignore rules incomplete: search stopped after 7 files because .gitignore rules were too costly to apply. Results so far are shown. Add a glob to narrow the search.]",
		);
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "inproc-cost-"));
		try {
			fs.writeFileSync(
				path.join(d, ".gitignore"),
				`${Array.from({ length: MAX_GITIGNORE_RULES }, (_, i) => `*${i}[a-z]*[!q]?x`).join("\n")}\n`,
			);
			for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(d, `f${i}.txt`), "needle\n");
			const r = await searchFiles({
				root: d,
				allow: () => true,
				pattern: "needle",
				maxResults: 100000,
				deadlineMs: 60000,
			});
			expect(formatSearch(r)).toContain("were too costly to apply");
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test("spawns nothing", async () => {
		const src = fs.readFileSync(path.join(import.meta.dir, "..", "inproc-search.ts"), "utf8");
		expect(src).not.toMatch(/child_process|Worker|execSync|spawnSync|Bun\.spawn/);
	});
});
