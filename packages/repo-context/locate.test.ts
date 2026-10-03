/**
 * #3427 trial: question narrowing behind EIGHT_LOCATE=1, reached through the
 * existing `locate` tool's prose route. Term extraction stays linear, the
 * narrowing finds the passage, rg paths cannot leave the root, the judge is
 * bounded, local-only and sees only scrubbed text, and with the flag unset the
 * tool list and the prose answer are exactly what they were.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearIndex, ensureIndexed } from "../ast-index";
import { formatLocate, locate } from "../ast-index/locate";
import { ToolExecutor } from "../eight/tools";
import {
	type Judge,
	MAX_RESULTS,
	MAX_TERMS,
	insideRoot,
	isLoopback,
	localJudge,
	locateCode,
	locateCodeEnabled,
	loopbackFetch,
	questionTerms,
} from "./locate";

let parent: string;
let root: string;
let repoId: string;
// A provider-shaped key the secret scanner redacts; it lives only in the temp fixture.
const FAKE_KEY = `AKIA${"ABCDEFGHIJKLMNOP"}`;
const OUTSIDE_MARK = "outsidemarkerword";
const ENV_KEYS = [
	"EIGHT_LOCATE",
	"EIGHT_S1_SHARED_JUDGE",
	"EIGHT_DECIDE_OLLAMA_HOST",
	"OLLAMA_HOST",
	"OLLAMA_BASE_URL",
	"LAYA_URL",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function write(rel: string, body: string, base = root): void {
	fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
	fs.writeFileSync(path.join(base, rel), body);
}

/** Every model host the decider could reach: a closed loopback port, so a judge fails fast and locally. */
function closedLocalHosts(): void {
	process.env.EIGHT_S1_SHARED_JUDGE = "0";
	for (const k of ["EIGHT_DECIDE_OLLAMA_HOST", "OLLAMA_HOST", "LAYA_URL"])
		process.env[k] = "http://127.0.0.1:9";
	delete process.env.OLLAMA_BASE_URL;
}

beforeAll(async () => {
	parent = fs.mkdtempSync(path.join(os.tmpdir(), "locate-code-"));
	root = path.join(parent, "repo");
	fs.mkdirSync(root);
	write(
		"packages/guard/sanitizer.ts",
		[
			"// Shell guard.",
			"import { x } from './x';",
			"",
			"/** Reject shell commands that chain or substitute. */",
			"export function sanitizeShellCommand(command: string): boolean {",
			"\treturn !/[;&|`]/.test(command);",
			"}",
			"",
		].join("\n"),
	);
	write(
		"packages/output/trim.ts",
		[
			"export function capOutput(text: string): string {",
			`\tconst truncated = text.slice(0, 10) + "${FAKE_KEY}" + "${"y".repeat(400)}"; // long output head tail`,
			"\treturn truncated;",
			"}",
			"",
		].join("\n"),
	);
	write("packages/other/noise.ts", "export const unrelated = 1;\n");
	// Outside the root, and a directory whose name holds a newline and "..":
	// with newline-split rg output this read ../outside.ts (8SO M1).
	write("outside.ts", `export const ${OUTSIDE_MARK} = "${OUTSIDE_MARK} zebra";\n`, parent);
	write(`x\n../outside.ts`, `export const inner = "zebra";\n`);
	repoId = (await ensureIndexed(root)).id;
});

afterAll(() => {
	clearIndex(root);
	fs.rmSync(parent, { recursive: true, force: true });
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
});

describe("questionTerms", () => {
	test("drops stop words, stems, splits hyphens and paths", () => {
		expect(questionTerms("where are secrets scrubbed from tool output")).toEqual([
			"secret",
			"scrub",
			"tool",
			"output",
		]);
		expect(questionTerms("where does the 50-call breaker count calls")).toEqual([
			"call",
			"break",
			"count",
		]);
		expect(questionTerms("where is it classified")).toEqual(["classif"]);
	});

	test("caps the term count and skips oversized tokens", () => {
		const many = Array.from(
			{ length: 40 },
			(_, i) => `word${String.fromCharCode(97 + (i % 26))}${i}`,
		);
		expect(questionTerms(many.join(" ")).length).toBe(MAX_TERMS);
		expect(questionTerms(`${"z".repeat(100)} sanitizer`)).toEqual(["sanitiz"]);
	});

	test("stays linear on long hostile input", () => {
		const inputs = [
			"a".repeat(1_000_000),
			"a-".repeat(500_000),
			" ".repeat(1_000_000),
			"ab ".repeat(300_000),
			`${"(a+)+".repeat(100_000)}!`,
		];
		for (const input of inputs) {
			const t0 = performance.now();
			questionTerms(input);
			expect(performance.now() - t0).toBeLessThan(200);
		}
	});
});

describe("locateCode, deterministic", () => {
	test("finds the passage with file:line and its declaration", async () => {
		const r = await locateCode("where is the shell command sanitizer", {
			root,
			repoId,
			judge: null,
		});
		expect(r.passages[0].file).toBe("packages/guard/sanitizer.ts");
		expect(r.passages[0].line).toBe(5);
		expect(r.passages[0].symbol).toBe("sanitizeShellCommand");
		expect(r.judge).toEqual({ used: false, calls: 0, note: "no local model, deterministic order" });
		expect(r.passages.length).toBeLessThanOrEqual(MAX_RESULTS);
	});

	test("scrubs before it caps: no line shows the key, whole or cut", async () => {
		const r = await locateCode("where is long output truncated head tail", {
			root,
			repoId,
			judge: null,
		});
		const p = r.passages.find((x) => x.file === "packages/output/trim.ts");
		expect(p).toBeDefined();
		const lines = (p?.excerpt ?? "").split("\n");
		expect(lines.length).toBeLessThanOrEqual(8);
		for (const l of [...lines, p?.text ?? ""]) {
			expect(l.length).toBeLessThanOrEqual(170);
			expect(l).not.toContain("AKIAABCD");
		}
		expect(p?.excerpt).toContain("[REDACTED:");
	});

	test("a question with no searchable words answers without searching", async () => {
		const r = await locateCode("where is the", { root, repoId, judge: null });
		expect(r.passages).toEqual([]);
	});
});

describe("paths stay inside the root (8SO M1)", () => {
	test("a newline-and-dot-dot directory name cannot read outside the root", async () => {
		const r = await locateCode("where is zebra", { root, repoId, judge: null });
		for (const p of r.passages) {
			expect(insideRoot(root, p.file)).toBe(p.file);
			expect(`${p.text}\n${p.excerpt}`).not.toContain(OUTSIDE_MARK);
		}
		expect(r.passages.map((p) => p.file)).toContain("x\n../outside.ts");
	});

	test("insideRoot refuses .., absolute paths and symlinks out", () => {
		expect(insideRoot(root, "../outside.ts")).toBeNull();
		expect(insideRoot(root, path.join(parent, "outside.ts"))).toBeNull();
		fs.symlinkSync(path.join(parent, "outside.ts"), path.join(root, "link.ts"));
		try {
			expect(insideRoot(root, "link.ts")).toBeNull();
		} finally {
			fs.unlinkSync(path.join(root, "link.ts"));
		}
		expect(insideRoot(root, "packages/other/noise.ts")).toBe("packages/other/noise.ts");
	});
});

describe("judge", () => {
	const q = "where is shell output";

	test("one call reranks by the model's probabilities", async () => {
		let calls = 0;
		const judge: Judge = async (_q, options) => {
			calls++;
			return options.map((o) =>
				o.startsWith("packages/output/trim.ts") ? 0.99 : 0.01 / options.length,
			);
		};
		const r = await locateCode(q, { root, repoId, judge });
		expect(calls).toBe(1);
		expect(r.judge.used).toBe(true);
		expect(r.passages[0].file).toBe("packages/output/trim.ts");
	});

	test("the question and every option reach the judge scrubbed (8SO M2)", async () => {
		const seen: string[] = [];
		const judge: Judge = async (question, options) => {
			seen.push(question, ...options);
			return options.map(() => 1 / options.length);
		};
		await locateCode(`where is shell output truncated ${FAKE_KEY}`, {
			root,
			repoId,
			judge,
		});
		expect(seen.length).toBeGreaterThan(2);
		for (const s of seen) expect(s).not.toContain("AKIAABCD");
	});

	test("a failing, malformed or slow judge leaves the deterministic order", async () => {
		const base = await locateCode(q, { root, repoId, judge: null });
		const order = base.passages.map((p) => p.file);
		const failing: Judge = async () => {
			throw new Error("down");
		};
		const malformed: Judge = async () => [Number.NaN];
		const slow: Judge = () => new Promise((resolve) => setTimeout(() => resolve([1, 0, 0]), 2000));
		for (const judge of [failing, malformed, slow]) {
			const t0 = performance.now();
			const r = await locateCode(q, { root, repoId, judge, judgeTimeoutMs: 100 });
			expect(performance.now() - t0).toBeLessThan(1500);
			expect(r.judge.used).toBe(false);
			expect(r.judge.calls).toBe(1);
			expect(r.passages.map((p) => p.file)).toEqual(order);
		}
	});
});

describe("loopback only (8SO H1, H2)", () => {
	test("only localhost or a loopback IP literal counts", () => {
		for (const ok of [
			"http://localhost:11434",
			"http://127.0.0.1:11434",
			"http://127.3.2.1",
			"http://[::1]:11434",
		]) {
			expect(isLoopback(ok)).toBe(true);
		}
		for (const bad of [
			"http://127.evil.example",
			"http://127.0.0.1.nip.io:11434",
			"http://localhost.evil.example",
			"http://10.0.0.5:11434",
			"http://models.example.com",
			"not a url",
		]) {
			expect(isLoopback(bad)).toBe(false);
		}
	});

	test("the decider's fetch refuses a remote URL without sending it", async () => {
		await expect(loopbackFetch("http://127.evil.example/api/tags")).rejects.toThrow(
			"not on this machine",
		);
	});

	test("a remote shared judge, Ollama or Laya host is refused before any request", async () => {
		const remote = [
			{ EIGHT_DECIDE_OLLAMA_HOST: "http://judge.example.com:11434" },
			{ EIGHT_DECIDE_OLLAMA_HOST: "http://127.evil.example:11434" },
			{ OLLAMA_HOST: "http://models.example.com:11434" },
			{ LAYA_URL: "https://laya.example.com" },
		];
		for (const env of remote) {
			await expect(localJudge(env)("q", ["a", "b"])).rejects.toThrow("not on this machine");
		}
	});
});

describe("EIGHT_LOCATE flag on the locate tool", () => {
	const prose = "where is the shell command sanitizer";

	test("only the exact value 1 turns it on", () => {
		expect(locateCodeEnabled({})).toBe(false);
		expect(locateCodeEnabled({ EIGHT_LOCATE: "true" })).toBe(false);
		expect(locateCodeEnabled({ EIGHT_LOCATE: "0" })).toBe(false);
		expect(locateCodeEnabled({ EIGHT_LOCATE: "1" })).toBe(true);
	});

	test("off: tool list unchanged, prose answered by hybrid as before", async () => {
		delete process.env.EIGHT_LOCATE;
		const executor = new ToolExecutor(root);
		const off = executor.getToolDefinitions();
		const r = await locate(prose, { root, repoId, systemOne: null, semantic: null });
		expect(r.route.mode).toBe("hybrid");
		expect(r.narrowed).toBeUndefined();
		expect(r.rows.every((row) => row.kind !== "passage")).toBe(true);
		process.env.EIGHT_LOCATE = "1";
		try {
			expect(executor.getToolDefinitions()).toEqual(off);
		} finally {
			delete process.env.EIGHT_LOCATE;
		}
	});

	test("on: prose gets passage rows with file:line, hermetic (closed local hosts)", async () => {
		closedLocalHosts();
		process.env.EIGHT_LOCATE = "1";
		try {
			const r = await locate(prose, { root, repoId, systemOne: null, semantic: null });
			expect(r.rows[0]).toMatchObject({
				file: "packages/guard/sanitizer.ts",
				line: 5,
				kind: "passage",
			});
			expect(r.narrowed).toBeDefined();
			const out = formatLocate(r);
			expect(out).toContain("packages/guard/sanitizer.ts:5 passage sanitizeShellCommand:");
			expect(out).toContain("Rows from question narrowing (EIGHT_LOCATE=1 trial;");
			// Names still route to the symbol index, untouched by the flag.
			const named = await locate("sanitizeShellCommand", {
				root,
				repoId,
				systemOne: null,
				semantic: null,
			});
			expect(named.route.mode).toBe("symbol");
			expect(named.narrowed).toBeUndefined();
		} finally {
			delete process.env.EIGHT_LOCATE;
		}
	});
});
