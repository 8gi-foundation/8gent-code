/**
 * locate_code trial (#3427): term extraction stays linear, the narrowing finds
 * the passage, the judge is bounded and local-only, output is scrubbed and
 * capped, and with EIGHT_LOCATE unset the tool list is exactly what it was.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearIndex, ensureIndexed } from "../ast-index";
import { ToolExecutor } from "../eight/tools";
import {
	type Judge,
	MAX_RESULTS,
	MAX_TERMS,
	formatLocateCode,
	localJudge,
	locateCode,
	locateCodeEnabled,
	questionTerms,
} from "./locate";

let root: string;
let repoId: string;
const savedFlag = process.env.EIGHT_LOCATE;
// A provider-shaped key the secret scanner redacts; it lives only in the temp fixture.
const FAKE_KEY = `AKIA${"ABCDEFGHIJKLMNOP"}`;

function write(rel: string, body: string): void {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), body);
}

beforeAll(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "locate-code-"));
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
			"// Output helpers.",
			"export function capOutput(text: string): string {",
			"\t// long command output is truncated to head and tail",
			`\tconst sample = "${FAKE_KEY}";`,
			`\treturn text.slice(0, 10) + "${"y".repeat(400)}";`,
			"}",
			"",
		].join("\n"),
	);
	write("packages/other/noise.ts", "export const unrelated = 1;\n");
	repoId = (await ensureIndexed(root)).id;
});

afterAll(() => {
	clearIndex(root);
	fs.rmSync(root, { recursive: true, force: true });
	if (savedFlag === undefined) delete process.env.EIGHT_LOCATE;
	else process.env.EIGHT_LOCATE = savedFlag;
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

	test("caps passage lines and scrubs secrets from the tool text", async () => {
		const r = await locateCode("where is long command output truncated to head and tail", {
			root,
			repoId,
			judge: null,
		});
		expect(r.passages[0].file).toBe("packages/output/trim.ts");
		const lines = r.passages[0].excerpt.split("\n");
		expect(lines.length).toBeLessThanOrEqual(8);
		for (const l of lines) expect(l.length).toBeLessThanOrEqual(170);
		const out = formatLocateCode(r);
		expect(out).not.toContain(FAKE_KEY);
		expect(out).toContain("[REDACTED:");
		expect(out).toContain("packages/output/trim.ts:");
	});

	test("a question with no searchable words answers without searching", async () => {
		const r = await locateCode("where is the", { root, repoId, judge: null });
		expect(r.passages).toEqual([]);
		expect(formatLocateCode(r)).toContain("no passage holds these words");
	});
});

describe("locateCode, judge", () => {
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

	test("the local judge refuses a model host that is not on this machine", async () => {
		const judge = localJudge({ OLLAMA_HOST: "http://models.example.com:11434" });
		await expect(judge("q", ["a", "b"])).rejects.toThrow("not on this machine");
		const laya = localJudge({ LAYA_URL: "https://laya.example.com" });
		await expect(laya("q", ["a", "b"])).rejects.toThrow("not on this machine");
	});
});

describe("locate_code tool flag", () => {
	const names = (e: ToolExecutor) =>
		e.getToolDefinitions().map((d) => (d as { function: { name: string } }).function.name);

	test("only the exact value 1 turns it on", () => {
		expect(locateCodeEnabled({})).toBe(false);
		expect(locateCodeEnabled({ EIGHT_LOCATE: "true" })).toBe(false);
		expect(locateCodeEnabled({ EIGHT_LOCATE: "0" })).toBe(false);
		expect(locateCodeEnabled({ EIGHT_LOCATE: "1" })).toBe(true);
	});

	test("off: the tool list is identical and the tool is unknown", async () => {
		delete process.env.EIGHT_LOCATE;
		const executor = new ToolExecutor(root);
		const off = executor.getToolDefinitions();
		expect(names(executor)).not.toContain("locate_code");
		process.env.EIGHT_LOCATE = "1";
		const on = executor.getToolDefinitions();
		expect(
			on.filter((d) => (d as { function: { name: string } }).function.name !== "locate_code"),
		).toEqual(off);
		delete process.env.EIGHT_LOCATE;
		expect(await executor.execute("locate_code", { question: "where is the sanitizer" })).toBe(
			"Unknown tool: locate_code",
		);
	});

	test("on: listed once and answers through the executor", async () => {
		process.env.EIGHT_LOCATE = "1";
		// No model in tests: point the judge at a closed loopback port so it fails fast and locally.
		const savedHost = process.env.OLLAMA_HOST;
		process.env.OLLAMA_HOST = "http://127.0.0.1:9";
		try {
			const executor = new ToolExecutor(root);
			expect(names(executor).filter((n) => n === "locate_code")).toHaveLength(1);
			const out = await executor.execute("locate_code", {
				question: "where is the shell command sanitizer",
			});
			expect(out.split("\n")[0]).toStartWith("locate_code: shell command sanitiz [");
			expect(out).toContain("packages/guard/sanitizer.ts:5 in sanitizeShellCommand");
		} finally {
			delete process.env.EIGHT_LOCATE;
			if (savedHost === undefined) delete process.env.OLLAMA_HOST;
			else process.env.OLLAMA_HOST = savedHost;
		}
	});
});
