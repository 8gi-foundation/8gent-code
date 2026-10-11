/**
 * edit_file refuses an ambiguous oldText (#3898). A duplicate block used to be
 * edited silently at its first copy. startLine picks a copy; a refusal is
 * logged to ~/.8gent/edit-ambiguous.jsonl so it can be counted.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.EIGHT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "edit-amb-data-"));

const { applyEdit, locateEdit } = await import("./write-content-gate");
const { ToolExecutor } = await import("../eight/tools");
const { agentTools, setToolContext } = await import("../ai/tools");

const DUP = ["alpha();", "mid();", "alpha();", "tail();", "alpha();", ""].join("\n");

let dir: string;
let home: string | undefined;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-amb-ws-"));
	home = process.env.HOME;
	process.env.HOME = dir;
});
afterEach(() => {
	process.env.HOME = home;
	fs.rmSync(dir, { recursive: true, force: true });
});
const put = (f: string, c: string) => fs.writeFileSync(path.join(dir, f), c);
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf-8");
const logLines = () => {
	const p = path.join(dir, ".8gent", "edit-ambiguous.jsonl");
	return fs.existsSync(p) ? fs.readFileSync(p, "utf-8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};

describe("locateEdit / applyEdit", () => {
	test("single match applies", () => {
		expect(applyEdit("a\nb\nc\n", "b", "B")).toBe("a\nB\nc\n");
	});
	test("duplicate is ambiguous with line numbers and applyEdit returns null", () => {
		expect(locateEdit(DUP, "alpha();")).toEqual({ kind: "ambiguous", lines: [1, 3, 5] });
		expect(applyEdit(DUP, "alpha();", "x();")).toBeNull();
	});
	test("startLine picks the first copy at or after that line", () => {
		expect(applyEdit(DUP, "alpha();", "x();", 3)).toBe("alpha();\nmid();\nx();\ntail();\nalpha();\n");
		expect(applyEdit(DUP, "alpha();", "x();", 4)).toBe("alpha();\nmid();\nalpha();\ntail();\nx();\n");
	});
	test("startLine past every copy refuses", () => {
		expect(locateEdit(DUP, "alpha();", 6).kind).toBe("none-after");
	});
	test("empty oldText is none, not an endless scan", () => {
		expect(locateEdit("abc", "").kind).toBe("none");
		expect(applyEdit("abc", "", "x")).toBeNull();
	});
	test("not found is unchanged", () => {
		expect(locateEdit("abc", "zzz").kind).toBe("none");
		expect(applyEdit("abc", "zzz", "y")).toBeNull();
	});
});

describe("ToolExecutor edit_file (text-tool path)", () => {
	test("single match edits as before", async () => {
		put("a.ts", "one\ntwo\n");
		const out = await new ToolExecutor(dir, "primary").execute("edit_file", { path: "a.ts", oldText: "two", newText: "2" });
		expect(out).toContain("File edited");
		expect(read("a.ts")).toBe("one\n2\n");
		expect(logLines()).toHaveLength(0);
	});
	test("duplicate is refused, file untouched, count and lines named, refusal logged", async () => {
		put("a.ts", DUP);
		const out = await new ToolExecutor(dir, "primary").execute("edit_file", { path: "a.ts", oldText: "alpha();", newText: "x();" });
		expect(out).toContain("matches 3 times");
		expect(out).toContain("lines 1, 3, 5");
		expect(read("a.ts")).toBe(DUP);
		const log = logLines();
		expect(log).toHaveLength(1);
		expect(log[0]).toMatchObject({ kind: "ambiguous", lines: [1, 3, 5], oldTextLength: 8 });
		expect(JSON.stringify(log[0])).not.toContain("alpha");
	});
	test("startLine edits the right copy", async () => {
		put("a.ts", DUP);
		const out = await new ToolExecutor(dir, "primary").execute("edit_file", { path: "a.ts", oldText: "alpha();", newText: "x();", startLine: 3 });
		expect(out).toContain("File edited");
		expect(read("a.ts")).toBe("alpha();\nmid();\nx();\ntail();\nalpha();\n");
	});
	test("not found keeps its existing error", async () => {
		put("a.ts", "one\n");
		const out = await new ToolExecutor(dir, "primary").execute("edit_file", { path: "a.ts", oldText: "nope", newText: "y" });
		expect(out).toContain("Could not find the text to replace");
		expect(logLines()).toHaveLength(0);
	});
});

describe("AI SDK edit_file (native path)", () => {
	const run = (input: Record<string, unknown>) =>
		(agentTools.edit_file as any).execute(input, { toolCallId: "t", messages: [] });
	test("duplicate refused, startLine honoured", async () => {
		setToolContext({ workingDirectory: dir } as any);
		put("b.ts", DUP);
		expect(await run({ path: "b.ts", oldText: "alpha();", newText: "x();" })).toContain("matches 3 times");
		expect(read("b.ts")).toBe(DUP);
		expect(await run({ path: "b.ts", oldText: "alpha();", newText: "x();", startLine: 5 })).toContain("File edited");
		expect(read("b.ts")).toBe("alpha();\nmid();\nalpha();\ntail();\nx();\n");
	});
});
