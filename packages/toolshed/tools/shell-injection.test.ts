/**
 * Toolshed tools that put a model-supplied string on a command line take it as
 * data, never as shell syntax (#3763). Every case plants a marker command in
 * the string and checks the marker never runs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionContext } from "../../types";
import { getTool } from "../registry/register";
import { isPlainArg } from "./execution/execution-tools";
import "./execution/run";
import "./repo/repo-tools";

let dir: string;
const ctx = (): ExecutionContext => ({
	sessionId: "t",
	workingDirectory: dir,
	permissions: [],
	sandbox: { type: "none", allowedPaths: [], networkAccess: false, timeout: 0 },
});
const run = (name: string, input: unknown) => {
	const tool = getTool(name);
	if (!tool) throw new Error(`no tool ${name}`);
	return tool.execute(input, ctx()) as Promise<any>;
};
const marker = () => existsSync(join(dir, "pwned"));

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "shell-inj-"));
	writeFileSync(join(dir, "a.ts"), "hello\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const PAYLOADS = ['x"; touch pwned; "', "$(touch pwned)", "`touch pwned`", "x'; touch pwned; '"];

describe("isPlainArg", () => {
	test("rejects quote, $, backtick, semicolon and newline; allows ordinary names", () => {
		for (const bad of ['a"b', "a'b", "a$b", "a`b", "a;b", "a\nb"])
			expect(isPlainArg(bad)).toBe(false);
		for (const ok of ["src/a.test.ts", "handles empty input", "left-pad@1.2.3"]) {
			expect(isPlainArg(ok)).toBe(true);
		}
	});
});

describe("run (fall-through to the system)", () => {
	// run's own ; chaining is a documented feature, so only payloads whose ; is quoted apply.
	for (const p of PAYLOADS.slice(0, 3)) {
		test(`does not re-parse ${JSON.stringify(p)}`, async () => {
			await run("run", { command: `ls ${p.includes(" ") ? `'${p}'` : p}` });
			expect(marker()).toBe(false);
		});
	}
	test("an argument with a space still reaches the program as one word", async () => {
		writeFileSync(join(dir, "two words.txt"), "ok");
		const out = await run("run", { command: 'cat "two words.txt"' });
		expect(JSON.stringify(out)).toContain("ok");
	});
});

describe("run_tests", () => {
	for (const p of PAYLOADS) {
		test(`file and grep are refused: ${JSON.stringify(p)}`, async () => {
			const a = await run("run_tests", { file: p });
			const b = await run("run_tests", { grep: p });
			expect(a.passed).toBe(false);
			expect(b.passed).toBe(false);
			expect(a.output).toContain("[BLOCKED]");
			expect(marker()).toBe(false);
		});
	}
});

describe("install_deps", () => {
	for (const p of [...PAYLOADS, "--registry=http://x"]) {
		test(`package is refused: ${JSON.stringify(p)}`, async () => {
			const out = await run("install_deps", { packages: [p] });
			expect(out.output).toContain("[BLOCKED]");
			expect(marker()).toBe(false);
		});
	}
});

describe("list_processes", () => {
	for (const p of PAYLOADS) {
		test(`filter is text: ${JSON.stringify(p)}`, async () => {
			const out = await run("list_processes", { filter: p });
			expect(out.processes).toEqual([]);
			expect(marker()).toBe(false);
		});
	}
	test("a non-numeric port is refused, not run", async () => {
		const out = await run("list_processes", { port: "1; touch pwned" });
		expect(out.message).toContain("Invalid port");
		expect(marker()).toBe(false);
	});
	test("an ordinary filter still matches", async () => {
		// Some sandboxes forbid ps; then there is nothing to match against.
		try {
			if (Bun.spawnSync(["ps", "aux"]).exitCode !== 0) return;
		} catch {
			return;
		}
		const out = await run("list_processes", { filter: "bun" });
		expect(out.processes.length).toBeGreaterThan(0);
	});
});

describe("find_files and search_code", () => {
	for (const p of PAYLOADS) {
		test(`find_files pattern is data: ${JSON.stringify(p)}`, async () => {
			const out = await run("find_files", { pattern: p });
			expect(out.count).toBe(0);
			expect(marker()).toBe(false);
		});
		test(`search_code pattern and fileType are data: ${JSON.stringify(p)}`, async () => {
			expect((await run("search_code", { pattern: p })).count).toBe(0);
			expect((await run("search_code", { pattern: "hello", fileType: p })).count).toBe(0);
			expect(marker()).toBe(false);
		});
	}
	test("ordinary searches still work", async () => {
		expect((await run("find_files", { pattern: "**/*.ts" })).files).toContain("./a.ts");
		expect((await run("search_code", { pattern: "hel+o" })).count).toBe(1);
	});
});
