/**
 * #70: hash-anchored edits. read_file prints the sha256 (first 12 hex) of the
 * lines it shows; edit_file takes it back as expected_hash and refuses, writing
 * nothing, when the lines it would replace no longer hash the same. No hash,
 * no change in behaviour.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { withEditHash } from "./range-hash";
import { ToolExecutor } from "./tools";

const EDIT_DEF = [{ function: { name: "edit_file", parameters: { properties: { path: {} } } } }];

afterAll(cleanupTempDirs);

let dir: string;
let executor: InstanceType<typeof ToolExecutor>;
const FILE = "a.txt";
const sha12 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const run = (tool: string, args: Record<string, unknown>) =>
	executor.execute(tool, args) as Promise<string>;
const disk = () => fs.readFileSync(path.join(dir, FILE), "utf-8");

const savedFlag = process.env.EIGHT_EDIT_HASH;
afterEach(() => {
	if (savedFlag === undefined) delete process.env.EIGHT_EDIT_HASH;
	else process.env.EIGHT_EDIT_HASH = savedFlag;
});

beforeEach(() => {
	process.env.EIGHT_EDIT_HASH = "1";
	dir = tempDir("hash-edit-");
	executor = new ToolExecutor(dir);
	fs.writeFileSync(path.join(dir, FILE), "one\ntwo\nthree\nfour\nfive\n");
});

describe("read_file hash", () => {
	test("a slice reports the hash of exactly the lines shown", async () => {
		const out = await run("read_file", { path: FILE, offset: 2, limit: 2 });
		expect(out).toContain(`[sha256 ${sha12("two\nthree")} lines 2-3]`);
	});

	test("a whole-file read reports the hash of every line", async () => {
		const out = await run("read_file", { path: FILE });
		expect(out).toContain(`[sha256 ${sha12("one\ntwo\nthree\nfour\nfive")} lines 1-5]`);
	});
});

describe("flag off (default)", () => {
	test("read_file prints no hash footer", async () => {
		delete process.env.EIGHT_EDIT_HASH;
		expect(await run("read_file", { path: FILE })).not.toContain("sha256");
	});
});

describe("tool definition", () => {
	const hasParam = (on: boolean) => {
		if (on) process.env.EIGHT_EDIT_HASH = "1";
		else delete process.env.EIGHT_EDIT_HASH;
		const defs = withEditHash(EDIT_DEF) as any[];
		return "expected_hash" in defs[0].function.parameters.properties;
	};
	test("expected_hash is advertised only with the flag on", () => {
		expect(hasParam(true)).toBe(true);
		expect(hasParam(false)).toBe(false);
	});
});

describe("edit_file expected_hash", () => {
	test("a matching hash applies the edit", async () => {
		const out = await run("edit_file", {
			path: FILE,
			oldText: "three",
			newText: "THREE",
			expected_hash: sha12("three"),
		});
		expect(out).toContain("File edited");
		expect(disk()).toBe("one\ntwo\nTHREE\nfour\nfive\n");
	});

	test("a changed line is refused, naming the lines, and nothing is written", async () => {
		const stale = sha12("three");
		fs.writeFileSync(path.join(dir, FILE), "one\ntwo\nthree plus\nfour\nfive\n");
		const before = disk();
		const out = await run("edit_file", {
			path: FILE,
			oldText: "three",
			newText: "THREE",
			expected_hash: stale,
		});
		expect(out).toContain("file changed since read, re-read lines 3-3");
		expect(disk()).toBe(before);
	});

	test("a hash from a read of the same lines is accepted", async () => {
		const read = await run("read_file", { path: FILE, offset: 2, limit: 2 });
		const hash = /\[sha256 (\w{12}) lines 2-3\]/.exec(read)?.[1];
		const out = await run("edit_file", {
			path: FILE,
			oldText: "two\nthree",
			newText: "2\n3",
			expected_hash: hash,
		});
		expect(out).toContain("File edited");
		expect(disk()).toBe("one\n2\n3\nfour\nfive\n");
	});

	test("without a hash the edit behaves as before", async () => {
		const out = await run("edit_file", { path: FILE, oldText: "three", newText: "THREE" });
		expect(out).toContain("File edited");
		expect(disk()).toBe("one\ntwo\nTHREE\nfour\nfive\n");
	});
});
