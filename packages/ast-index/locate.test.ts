/**
 * locate(query): routing rules (pure), path/grep ranking (pure), and the
 * end-to-end answer over a temp repo with the real index and real ripgrep.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearIndex, ensureIndexed } from "./index";
import {
	awaitIndex,
	contentTerms,
	formatLocate,
	locate,
	mergeRows,
	parseRgLines,
	pathToken,
	rankGrepHits,
	rankPaths,
	refreshDue,
	routeQuery,
	runRg,
} from "./locate";
import type { ProseRouting } from "./locate-system-one";

const has =
	(...names: string[]) =>
	(n: string) =>
		names.map((x) => x.toLowerCase()).includes(n.toLowerCase());
const none = () => false;

describe("routeQuery", () => {
	test("a path with a slash routes to path", () => {
		expect(routeQuery("packages/decide/index.ts", none)).toMatchObject({
			mode: "path",
			rule: "path",
			term: "packages/decide/index.ts",
		});
		expect(routeQuery("decide/rules", none)).toMatchObject({ mode: "path", term: "decide/rules" });
	});

	test("a bare file name with a known extension routes to path, with its line", () => {
		expect(routeQuery("rules.ts", none)).toMatchObject({ mode: "path", term: "rules.ts" });
		expect(routeQuery("package.json", none)).toMatchObject({ mode: "path", term: "package.json" });
		expect(routeQuery("./src/a.ts:42", none)).toEqual({
			mode: "path",
			rule: "path",
			term: "src/a.ts",
			line: 42,
		});
	});

	test("a dotted member that is not a file is an identifier, not a path", () => {
		expect(routeQuery("console.log", none)).toMatchObject({
			mode: "grep",
			rule: "identifier_no_symbol",
			term: "console.log",
		});
		expect(routeQuery("decider.choice", has("choice"))).toMatchObject({
			mode: "symbol",
			term: "choice",
		});
	});

	test("an identifier in the symbol map routes to symbol", () => {
		expect(routeQuery("createDecider", has("createDecider"))).toEqual({
			mode: "symbol",
			rule: "identifier",
			term: "createDecider",
		});
		expect(routeQuery("snake_case_name", has("snake_case_name"))).toMatchObject({ mode: "symbol" });
		expect(routeQuery("RepoMapper", has("RepoMapper"))).toMatchObject({ mode: "symbol" });
		expect(routeQuery("parse", has("parse"))).toMatchObject({ mode: "symbol", term: "parse" });
	});

	test("an identifier with no symbol hit routes to grep", () => {
		expect(routeQuery("createDecider", none)).toEqual({
			mode: "grep",
			rule: "identifier_no_symbol",
			term: "createDecider",
		});
	});

	test("a::b routes to the symbol b", () => {
		expect(routeQuery("Decider::choice", has("choice"))).toMatchObject({
			mode: "symbol",
			rule: "member",
			term: "choice",
		});
		expect(routeQuery("Decider::choice", none)).toMatchObject({
			mode: "grep",
			rule: "member_no_symbol",
			term: "Decider::choice",
		});
	});

	test("the code-shaped token in a question wins over plain words", () => {
		expect(routeQuery("where is createDecider defined?", has("createDecider"))).toMatchObject({
			mode: "symbol",
			term: "createDecider",
		});
		expect(routeQuery("where is the RepoMapper class", has("RepoMapper"))).toMatchObject({
			mode: "symbol",
			term: "RepoMapper",
		});
		expect(routeQuery("where is src/app.tsx", none)).toMatchObject({
			mode: "path",
			term: "src/app.tsx",
		});
	});

	test("quoted text routes to grep on the quoted part", () => {
		expect(routeQuery('"index not available"', none)).toEqual({
			mode: "grep",
			rule: "quoted",
			term: "index not available",
		});
		expect(routeQuery("where does `rate limited` come from", none)).toMatchObject({
			mode: "grep",
			term: "rate limited",
		});
		expect(routeQuery("'a/b.ts'", none)).toMatchObject({
			mode: "grep",
			rule: "quoted",
			term: "a/b.ts",
		});
	});

	test("an apostrophe inside a word is not a quote", () => {
		expect(routeQuery("where's the user's session store", none)).toMatchObject({
			mode: "hybrid",
			rule: "prose",
		});
		expect(routeQuery("can't open the lockfile", none)).toMatchObject({
			mode: "grep",
			rule: "error_like",
		});
	});

	test("an error-like string routes to grep on the whole text", () => {
		expect(routeQuery("Error: cannot find module", none)).toEqual({
			mode: "grep",
			rule: "error_like",
			term: "Error: cannot find module",
			fallback: {
				mode: "hybrid",
				rule: "prose",
				term: "Error: cannot find module",
				terms: ["error", "cannot", "module"],
			},
		});
		expect(routeQuery("AST index not available", none)).toMatchObject({
			mode: "grep",
			rule: "error_like",
		});
		expect(routeQuery("foo(bar) + 1", none)).toMatchObject({ mode: "grep", rule: "error_like" });
		expect(routeQuery("->", none)).toMatchObject({ mode: "grep" });
	});

	test("plain prose routes to hybrid with its content words", () => {
		const r = routeQuery("where is the bash guard threshold", none);
		expect(r).toMatchObject({ mode: "hybrid", rule: "prose" });
		expect(r.terms).toEqual(["bash", "guard", "threshold"]);
	});

	test("an empty or blank query routes to hybrid with nothing to search", () => {
		expect(routeQuery("", none)).toEqual({ mode: "hybrid", rule: "empty", term: "", terms: [] });
		expect(routeQuery("  \n\t", none)).toMatchObject({ rule: "empty" });
	});

	test("routing is deterministic", () => {
		const q = "where is createDecider defined?";
		expect(routeQuery(q, has("createDecider"))).toEqual(routeQuery(q, has("createDecider")));
	});
});

describe("pathToken", () => {
	test("rejects URLs, regexes and words", () => {
		expect(pathToken("https://x.dev/a")).toBeNull();
		expect(pathToken("a(b)/c")).toBeNull();
		expect(pathToken("hello")).toBeNull();
		expect(pathToken("/")).toBeNull();
		expect(pathToken("e.g.")).toBeNull();
	});
	test("strips wrapping punctuation", () => {
		expect(pathToken("(src/a.ts),")).toEqual({ path: "src/a.ts" });
	});
});

describe("contentTerms", () => {
	test("drops stopwords and short words, keeps at most four", () => {
		expect(
			contentTerms("where is the file that handles the tool rate limiter window size"),
		).toEqual(["tool", "rate", "limiter", "window"]);
	});
});

describe("rankPaths", () => {
	const files = [
		"packages/decide/rules.ts",
		"packages/decide/rules.test.ts",
		"apps/tui/src/rules.ts",
		"packages/decide/eval/run.ts",
		"README.md",
	];
	test("exact, then suffix, then contains, then basename, then fuzzy", () => {
		expect(rankPaths("packages/decide/rules.ts", files)[0]).toBe("packages/decide/rules.ts");
		expect(rankPaths("decide/rules.ts", files)[0]).toBe("packages/decide/rules.ts");
		expect(rankPaths("rules.ts", files).slice(0, 2)).toEqual([
			"apps/tui/src/rules.ts",
			"packages/decide/rules.ts",
		]);
		expect(rankPaths("other/run.ts", files)[0]).toBe("packages/decide/eval/run.ts");
		expect(rankPaths("dcdrl", files)[0]).toBe("packages/decide/rules.ts");
	});
	test("no match gives nothing, and the limit holds", () => {
		expect(rankPaths("zzz.qq", files)).toEqual([]);
		expect(rankPaths("s", files, 2)).toHaveLength(2);
	});
});

describe("grep ranking", () => {
	test("parseRgLines normalises a Windows backslash path to forward slashes", () => {
		expect(parseRgLines(".\\src\\a.ts\u00004:x")).toEqual([
			{ file: "src/a.ts", line: 4, text: "x" },
		]);
	});

	test("parseRgLines reads path NUL line:text (rg --null) and drops ./", () => {
		expect(parseRgLines("./a/b.ts\u000012:  const x = 1\nnot a hit\nc.md\u00003:x: y")).toEqual([
			{ file: "a/b.ts", line: 12, text: "  const x = 1" },
			{ file: "c.md", line: 3, text: "x: y" },
		]);
	});

	test("parseRgLines keeps a file name that contains :digits: whole", () => {
		expect(parseRgLines("./a:12:b.ts\u00007:hit")).toEqual([
			{ file: "a:12:b.ts", line: 7, text: "hit" },
		]);
	});

	test("a definition beats a use, source beats tests and docs, two rows per file", () => {
		const hits = [
			{ file: "docs/x.md", line: 1, text: "call makeThing" },
			{ file: "a.test.ts", line: 5, text: "makeThing()" },
			{ file: "b.ts", line: 9, text: "makeThing()" },
			{ file: "b.ts", line: 10, text: "makeThing()" },
			{ file: "b.ts", line: 11, text: "makeThing()" },
			{ file: "src/long/path/def.ts", line: 40, text: "export function makeThing(a: number) {" },
		];
		const ranked = rankGrepHits("makeThing", hits);
		expect(ranked[0]).toMatchObject({ file: "src/long/path/def.ts", line: 40 });
		expect(ranked.filter((h) => h.file === "b.ts")).toHaveLength(2);
		expect(ranked.map((h) => h.file).slice(-2)).toEqual(["a.test.ts", "docs/x.md"]);
	});
});

describe("mergeRows", () => {
	test("interleaves, drops repeated file:line, caps at five", () => {
		const r = (file: string, line: number) => ({ file, line, kind: "x", text: "" });
		const merged = mergeRows([
			[r("a", 1), r("a", 2), r("a", 3)],
			[r("a", 1), r("b", 1)],
			[r("c", 1), r("c", 2), r("c", 3)],
		]);
		expect(merged.map((x) => `${x.file}:${x.line}`)).toEqual(["a:1", "c:1", "a:2", "b:1", "c:2"]);
	});
});

// ------------------------------------------------------------------ end to end

let parent: string;
let root: string;
let repoId: string;

function write(rel: string, content: string, base = root): void {
	const abs = path.join(base, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
}

beforeAll(async () => {
	parent = fs.mkdtempSync(path.join(os.tmpdir(), "locate-"));
	root = path.join(parent, "repo");
	write(
		"src/decide/index.ts",
		"// decider\n\nexport function createDecider(opts: { model: string }) {\n\treturn opts;\n}\n",
	);
	write(
		"src/other.ts",
		"export function useIt() {\n\tconst createDecider = 1;\n\treturn createDecider;\n}\n",
	);
	write(
		"src/limits/rate-limiter.ts",
		"export class RateLimiter {\n\tcheck() {\n\t\treturn 'Rate limit exceeded for tool';\n\t}\n}\n",
	);
	write("tools/py_helper.py", "def only_in_python():\n    return 1\n");
	write("docs/guide.md", "# Guide\nUse createDecider to make one.\n");
	write("src/flags.ts", "export const FLAGS = ['--version', '$(touch pwned)'];\n");
	// The same text outside the repo root must never be returned.
	write("outside.ts", "export const leak = 'Rate limit exceeded for tool';\n", parent);
	repoId = (await ensureIndexed(root)).id;
});

afterAll(() => {
	clearIndex(repoId);
	fs.rmSync(parent, { recursive: true, force: true });
});

const ctx = () => ({ root, repoId });

describe("locate end to end", () => {
	test("symbol: the exported definition comes before a local constant of the same name", async () => {
		const r = await locate("createDecider", ctx());
		expect(r.route.mode).toBe("symbol");
		expect(r.rows[0]).toMatchObject({ file: "src/decide/index.ts", line: 3, kind: "function" });
		expect(r.rows[0].text).toContain("createDecider(opts");
		expect(r.rows.some((x) => x.file === "src/other.ts")).toBe(true);
	});

	test("path: a suffix finds the file and shows its symbols", async () => {
		const r = await locate("limits/rate-limiter.ts", ctx());
		expect(r.route.mode).toBe("path");
		expect(r.rows[0]).toMatchObject({ file: "src/limits/rate-limiter.ts", line: 1, kind: "file" });
		expect(r.rows[0].text).toContain("RateLimiter");
		const md = await locate("guide.md", ctx());
		expect(md.rows[0]).toMatchObject({ file: "docs/guide.md", text: "# Guide" });
	});

	test("grep: quoted text is found inside the root only", async () => {
		const r = await locate('"Rate limit exceeded for tool"', ctx());
		expect(r.route.mode).toBe("grep");
		expect(r.rows).toEqual([
			{
				file: "src/limits/rate-limiter.ts",
				line: 3,
				kind: "match",
				text: "return 'Rate limit exceeded for tool';",
			},
		]);
	});

	test("grep: an identifier the TS index cannot see is found by content", async () => {
		const r = await locate("only_in_python", ctx());
		expect(r.route).toMatchObject({ mode: "grep", rule: "identifier_no_symbol" });
		expect(r.rows[0]).toMatchObject({ file: "tools/py_helper.py", line: 1 });
	});

	test("grep: the query is a literal argument, never a flag or a shell string", async () => {
		const flag = await locate('"--version"', ctx());
		expect(flag.rows[0]).toMatchObject({ file: "src/flags.ts", line: 1 });
		const sub = await locate('"$(touch pwned)"', ctx());
		expect(sub.rows[0]).toMatchObject({ file: "src/flags.ts" });
		expect(fs.existsSync(path.join(root, "pwned"))).toBe(false);
		expect(fs.existsSync(path.join(process.cwd(), "pwned"))).toBe(false);
	});

	test("hybrid: prose finds the symbol and file that carry its words", async () => {
		const r = await locate("where is the rate limiter", ctx());
		expect(r.route.mode).toBe("hybrid");
		expect(r.rows.map((x) => x.file)).toContain("src/limits/rate-limiter.ts");
		expect(r.rows.length).toBeLessThanOrEqual(5);
	});

	test("a file written after the build is found without a rebuild", async () => {
		write("src/late.ts", "export function arrivedLate() {}\n");
		const r = await locate("arrivedLate", ctx());
		expect(r.route.mode).toBe("symbol");
		expect(r.rows[0]).toMatchObject({ file: "src/late.ts", line: 1 });
	});

	test("with no index, path and grep still answer", async () => {
		const r = await locate("createDecider", { root, repoId: null });
		expect(r.route.mode).toBe("grep");
		expect(r.rows[0]).toMatchObject({ file: "src/decide/index.ts", line: 3 });
	});

	test("the formatted answer is at most six lines and about 300 tokens", async () => {
		for (const q of [
			"createDecider",
			"src",
			"e",
			"where is the rate limiter",
			'"return"',
			"nothing_here_zz",
		]) {
			const out = formatLocate(await locate(q, ctx()));
			expect(out.split("\n").length).toBeLessThanOrEqual(6);
			expect(Math.ceil(out.length / 4)).toBeLessThanOrEqual(300);
		}
		expect(formatLocate(await locate("nothing_here_zz", ctx()))).toContain("no matches");
	});
});

describe("literal first, then a fallback reading", () => {
	test("three plain words that are not a question are grepped literally, prose as the fallback", () => {
		expect(routeQuery("bash guard threshold", none)).toEqual({
			mode: "grep",
			rule: "phrase",
			term: "bash guard threshold",
			fallback: {
				mode: "hybrid",
				rule: "prose",
				term: "bash guard threshold",
				terms: ["bash", "guard", "threshold"],
			},
		});
		expect(routeQuery("where is bash guard threshold", none)).toMatchObject({ mode: "hybrid" });
	});

	test("a message that carries a path or an identifier is still text first", () => {
		// Both were eval misses: the path and the identifier won over the message.
		expect(routeQuery("model results have no row; re-run eval/run.ts", none)).toMatchObject({
			mode: "grep",
			fallback: { mode: "path", term: "eval/run.ts" },
		});
		expect(routeQuery("llamacpp backend needs a modelPath", has("modelPath"))).toMatchObject({
			mode: "grep",
			rule: "phrase",
			fallback: { mode: "symbol", term: "modelPath" },
		});
	});

	test("a phrase with no literal hit falls back to hybrid", async () => {
		const r = await locate("limiter rate check", ctx());
		expect(r.route.rule).toBe("prose");
		expect(r.rows.map((x) => x.file)).toContain("src/limits/rate-limiter.ts");
	});

	test("a message found literally wins over the path and name inside it", async () => {
		write(
			"src/msg.ts",
			"export const M = 'run it again with src/decide/index.ts and createDecider now';\n",
		);
		const r = await locate("run it again with src/decide/index.ts and createDecider now", ctx());
		expect(r.route.rule).toBe("phrase");
		expect(r.rows[0]).toMatchObject({ file: "src/msg.ts", line: 1 });
		const miss = await locate("please open src/decide/index.ts for me", ctx());
		expect(miss.route.mode).toBe("path");
		expect(miss.rows[0]).toMatchObject({ file: "src/decide/index.ts" });
	});
});

// A tree larger than any output chunk rg writes at once, so a line cap on its
// output would cut the listing (and, with a parallel walker, cut it at random).
describe("a repo larger than one rg output chunk", () => {
	let big: string;
	const FILES = 12_000;

	beforeAll(() => {
		big = fs.mkdtempSync(path.join(os.tmpdir(), "locate-big-"));
		for (let d = 0; d < FILES / 100; d++) {
			const dir = path.join(big, `m${d}`);
			fs.mkdirSync(dir);
			for (let f = 0; f < 100; f++) {
				fs.writeFileSync(path.join(dir, `f${d * 100 + f}.ts`), "");
			}
		}
		fs.mkdirSync(path.join(big, "zz"));
		fs.writeFileSync(path.join(big, "zz/needle-target.ts"), "export const x = 1;\n");
		// A common name: 300 files x 20 uses (6,000 lines) and one definition
		// in a file that sorts and walks last.
		const uses = Array.from({ length: 20 }, () => "commonThing();").join("\n");
		for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(big, `m${i % 10}/use${i}.ts`), uses);
		fs.writeFileSync(path.join(big, "zz/def.ts"), "export function commonThing() {}\n");
	}, 60_000);

	afterAll(() => {
		fs.rmSync(big, { recursive: true, force: true });
	});

	// These check what is found, not how fast: a generous rg limit and test
	// timeout keep a heavily loaded machine from failing them.
	const SLOW = 60_000;

	test(
		"path: a file outside the first few thousand listed is still found, every run",
		async () => {
			for (let i = 0; i < 3; i++) {
				const r = await locate("needle-target.ts", { root: big, repoId: null, rgTimeoutMs: SLOW });
				expect(r.rows[0]).toMatchObject({ file: "zz/needle-target.ts", kind: "file" });
			}
		},
		SLOW,
	);

	test(
		"path: the same query gives the same rows every run",
		async () => {
			const runs = await Promise.all(
				[0, 1, 2].map(() => locate("f4999.ts", { root: big, repoId: null, rgTimeoutMs: SLOW })),
			);
			expect(runs[0].rows[0]).toMatchObject({ file: "m49/f4999.ts" });
			expect(runs[1].rows).toEqual(runs[0].rows);
			expect(runs[2].rows).toEqual(runs[0].rows);
		},
		SLOW,
	);

	test(
		"grep: the definition of a common name is not cut before ranking",
		async () => {
			const runs = [];
			for (let i = 0; i < 3; i++)
				runs.push(await locate("commonThing", { root: big, repoId: null, rgTimeoutMs: SLOW }));
			expect(runs[0].route.mode).toBe("grep");
			expect(runs[0].rows[0]).toMatchObject({ file: "zz/def.ts", line: 1 });
			expect(runs[1].rows).toEqual(runs[0].rows);
			expect(runs[2].rows).toEqual(runs[0].rows);
		},
		SLOW,
	);
});

describe("ripgrep missing", () => {
	test("the answer says rg is unavailable instead of 'no matches'", async () => {
		const r = await locate('"Rate limit exceeded for tool"', {
			root,
			repoId,
			rg: path.join(parent, "no-such-dir", "rg"),
		});
		expect(r.rgMissing).toBe(true);
		const out = formatLocate(r);
		expect(out).toContain("ripgrep (rg) was not found");
		expect(out).not.toContain("no matches");
	});

	test("with PATH that has no rg, the same note appears", async () => {
		const saved = process.env.PATH;
		process.env.PATH = path.join(parent, "no-such-dir");
		try {
			const r = await locate('"Rate limit exceeded for tool"', { root, repoId });
			expect(formatLocate(r)).toContain("ripgrep (rg) was not found");
		} finally {
			process.env.PATH = saved;
		}
	});

	test("symbol mode still answers from the index without rg", async () => {
		const r = await locate("createDecider", { root, repoId, rg: path.join(parent, "nope", "rg") });
		expect(r.rows[0]).toMatchObject({ file: "src/decide/index.ts", line: 3 });
		expect(formatLocate(r)).not.toContain("ripgrep");
	});
});

describe("refreshDue", () => {
	test("never refreshed: refresh", () => {
		expect(refreshDue(undefined, 1000)).toBe(true);
	});
	test("a cheap refresh runs on every call, so a file written a moment ago is seen", () => {
		expect(refreshDue({ at: 1000, costMs: 20 }, 1001)).toBe(true);
	});
	test("an expensive refresh is skipped until ten times its cost has passed", () => {
		expect(refreshDue({ at: 1000, costMs: 200 }, 1500)).toBe(false);
		expect(refreshDue({ at: 1000, costMs: 200 }, 3000)).toBe(true);
	});
	test("the skip window is capped at five seconds", () => {
		expect(refreshDue({ at: 1000, costMs: 2000 }, 5999)).toBe(false);
		expect(refreshDue({ at: 1000, costMs: 2000 }, 6000)).toBe(true);
	});
});

describe("ripgrep timeout", () => {
	let slowDir: string;
	let slowRg: string;
	let countFile: string;
	beforeAll(() => {
		slowDir = fs.mkdtempSync(path.join(os.tmpdir(), "locate-slow-rg-"));
		countFile = path.join(slowDir, "calls");
		slowRg = path.join(slowDir, "rg");
		// A stand-in rg that records each start, then hangs past the time limit.
		fs.writeFileSync(slowRg, `#!/bin/sh\necho x >> '${countFile}'\nexec sleep 5\n`);
		fs.chmodSync(slowRg, 0o755);
	});
	afterAll(() => fs.rmSync(slowDir, { recursive: true, force: true }));
	const calls = () =>
		fs.existsSync(countFile)
			? fs.readFileSync(countFile, "utf8").split("\n").filter(Boolean).length
			: 0;

	test("runRg reports a timeout as its own cause", async () => {
		fs.rmSync(countFile, { force: true });
		const out = await runRg(root, ["--files"], { bin: slowRg, timeoutMs: 100 });
		expect(out).toMatchObject({ truncated: true, timedOut: true, missing: false });
	});

	test("grep: a timeout is reported, never 'no matches', and is not retried", async () => {
		fs.rmSync(countFile, { force: true });
		const t0 = performance.now();
		const r = await locate('"Rate limit exceeded for tool"', {
			root,
			repoId,
			rg: slowRg,
			rgTimeoutMs: 400,
		});
		const ms = performance.now() - t0;
		expect(r.incomplete).toBe(true);
		// One rg start: no --sort path re-run and no case-insensitive re-run,
		// each of which would cost another full time limit. (Under load the
		// stand-in can be stopped before it records its start, hence <= 1.)
		expect(calls()).toBeLessThanOrEqual(1);
		expect(ms).toBeLessThan(2 * 400);
		const out = formatLocate(r);
		expect(out).toContain("stopped after");
		expect(out).not.toContain("no matches");
	});

	test("path: after a listing timeout the indexed files are still ranked", async () => {
		fs.rmSync(countFile, { force: true });
		const r = await locate("decide/index.ts", { root, repoId, rg: slowRg, rgTimeoutMs: 150 });
		expect(r.incomplete).toBe(true);
		expect(r.rows[0]).toMatchObject({ file: "src/decide/index.ts", kind: "file" });
		expect(formatLocate(r)).toContain("stopped after");
	});

	test("a run that finishes in time is not marked incomplete", async () => {
		// A generous limit, so a loaded machine cannot turn this into a timeout.
		const r = await locate('"Rate limit exceeded for tool"', { ...ctx(), rgTimeoutMs: 20_000 });
		expect(r.incomplete).toBeUndefined();
		expect(formatLocate(r)).not.toContain("stopped after");
	});
});

describe("a file name that contains :digits:", () => {
	test("grep returns the whole file name", async () => {
		write("odd/a:12:b.ts", "export const colonNamedMarker = 1;\n");
		const r = await locate('"colonNamedMarker"', ctx());
		expect(r.rows[0]).toMatchObject({ file: "odd/a:12:b.ts", line: 1 });
	});
});

describe("prose with no row carrying two words", () => {
	test("the answer suggests one word to retry with", async () => {
		write("src/pre.ts", "export function prefilterCommand() {}\n");
		const r = await locate("where is the rule prefilter", ctx());
		expect(r.route.mode).toBe("hybrid");
		expect(r.rows).toEqual([]);
		const out = formatLocate(r);
		expect(out).toContain('locate("prefilter")');
	});
});

describe("index still building", () => {
	test("awaitIndex waits at most the given time", async () => {
		const never = new Promise<string>(() => {});
		const t0 = performance.now();
		expect(await awaitIndex(never, 50)).toEqual({ repoId: null, pending: true });
		expect(performance.now() - t0).toBeLessThan(500);
		expect(await awaitIndex(Promise.resolve("id"), 50)).toEqual({ repoId: "id", pending: false });
		expect(await awaitIndex(Promise.reject(new Error("x")), 50)).toEqual({
			repoId: null,
			pending: false,
		});
		expect(await awaitIndex(Promise.resolve(null), 50)).toEqual({ repoId: null, pending: false });
	});

	test("an answer given before the index is ready says so", async () => {
		const r = await locate("createDecider", { root, repoId: null, indexPending: true });
		expect(r.rows[0]).toMatchObject({ file: "src/decide/index.ts", line: 3 });
		expect(formatLocate(r)).toContain("symbol index is still building");
		expect(formatLocate(await locate("createDecider", { root, repoId: null }))).not.toContain(
			"still building",
		);
	});
});

describe("System One on prose (EIGHT_SYSTEM_ONE_LOCATE)", () => {
	/** A router that always answers `mode` and counts its calls. */
	function router(mode: ProseRouting["mode"], reason: ProseRouting["reason"] = "model") {
		const calls: string[] = [];
		const fn = async (q: string): Promise<ProseRouting> => {
			calls.push(q);
			return {
				mode: reason === "model" ? mode : "hybrid",
				chosen: mode,
				confidence: 0.9,
				threshold: 0.5,
				reason,
				latencyMs: 1,
			};
		};
		return { fn, calls };
	}

	test("a kept mode runs that mode's own search over the query words", async () => {
		const path1 = router("path");
		const p = await locate("where is the rate limiter", { ...ctx(), systemOne: path1.fn });
		expect(path1.calls).toEqual(["where is the rate limiter"]);
		expect(p.route).toMatchObject({ mode: "path", rule: "system_one" });
		expect(p.route.systemOne).toMatchObject({ chosen: "path", reason: "model" });
		expect(p.rows[0]).toMatchObject({ file: "src/limits/rate-limiter.ts", kind: "file" });
		expect(p.rows.every((r) => r.kind === "file")).toBe(true);

		const grep = await locate("where is the rate limiter", {
			...ctx(),
			systemOne: router("grep").fn,
		});
		expect(grep.route).toMatchObject({ mode: "grep", rule: "system_one" });
		expect(grep.rows.length).toBeGreaterThan(0);
		expect(grep.rows.every((r) => r.kind === "match")).toBe(true);

		const sym = await locate("where is the rate limiter", {
			...ctx(),
			systemOne: router("symbol").fn,
		});
		expect(sym.route).toMatchObject({ mode: "symbol", rule: "system_one" });
		expect(sym.rows[0]).toMatchObject({ file: "src/limits/rate-limiter.ts", kind: "class" });
		expect(sym.rows.every((r) => r.kind !== "file" && r.kind !== "match")).toBe(true);
	});

	test("a kept mode that finds nothing falls back to the rules' hybrid answer", async () => {
		const plain = await locate("where is the zorblax wibble", { ...ctx(), systemOne: null });
		const got = await locate("where is the zorblax wibble", {
			...ctx(),
			systemOne: router("symbol").fn,
		});
		expect(got.route).toMatchObject({
			mode: "hybrid",
			rule: "prose",
			systemOne: { chosen: "symbol", reason: "no_rows" },
		});
		expect(got.rows).toEqual(plain.rows);
	});

	test("below the threshold, hybrid, or semantic with no search: the rules' hybrid answer, unchanged", async () => {
		const plain = await locate("where is the rate limiter", { ...ctx(), systemOne: null });
		for (const r of [
			router("symbol", "below_threshold"),
			router("semantic"),
			router("hybrid"),
			router("path", "timeout"),
		]) {
			const got = await locate("where is the rate limiter", {
				...ctx(),
				systemOne: r.fn,
				semantic: null,
			});
			expect(got.route).toMatchObject({ mode: "hybrid", rule: "prose" });
			expect(got.route.systemOne).toBeDefined();
			expect(got.rows).toEqual(plain.rows);
		}
	});

	test("a router that throws is treated as hybrid", async () => {
		const plain = await locate("where is the rate limiter", { ...ctx(), systemOne: null });
		const got = await locate("where is the rate limiter", {
			...ctx(),
			systemOne: async () => {
				throw new Error("boom");
			},
		});
		expect(got.route).toMatchObject({
			mode: "hybrid",
			rule: "prose",
			systemOne: { reason: "error" },
		});
		expect(got.rows).toEqual(plain.rows);
	});

	test("only prose reaches the model", async () => {
		const r = router("path");
		for (const q of [
			"createDecider",
			"limits/rate-limiter.ts",
			'"Rate limit exceeded for tool"',
			"only_in_python",
			"",
		]) {
			await locate(q, { ...ctx(), systemOne: r.fn });
		}
		expect(r.calls).toEqual([]);
		// A phrase found literally never asks; one with no literal hit asks once for its prose reading.
		await locate("Rate limit exceeded for tool", { ...ctx(), systemOne: r.fn });
		expect(r.calls).toEqual([]);
		await locate("limiter rate check", { ...ctx(), systemOne: r.fn });
		expect(r.calls).toEqual(["limiter rate check"]);
	});

	test("off by default: no router unless the flag is set", async () => {
		const saved = process.env.EIGHT_SYSTEM_ONE_LOCATE;
		delete process.env.EIGHT_SYSTEM_ONE_LOCATE;
		try {
			const got = await locate("where is the rate limiter", ctx());
			expect(got.route).toMatchObject({ mode: "hybrid", rule: "prose" });
			expect(got.route.systemOne).toBeUndefined();
		} finally {
			if (saved !== undefined) process.env.EIGHT_SYSTEM_ONE_LOCATE = saved;
		}
	});

	test("the header says System One chose the mode, or why it did not", async () => {
		const led = formatLocate(
			await locate("where is the rate limiter", { ...ctx(), systemOne: router("path").fn }),
		);
		expect(led.split("\n")[0]).toBe("locate path (system_one path 0.90): rate limiter");
		const low = formatLocate(
			await locate("where is the rate limiter", {
				...ctx(),
				systemOne: router("symbol", "below_threshold").fn,
			}),
		);
		expect(low.split("\n")[0]).toBe(
			"locate hybrid (prose, system_one below_threshold symbol 0.90): rate limiter",
		);
	});
});
