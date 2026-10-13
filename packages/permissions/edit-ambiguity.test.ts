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

const { applyEdit, locateEdit, editRefusal, logEditRefusal } = await import("./write-content-gate");
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
		expect(locateEdit(DUP, "alpha();")).toEqual({ kind: "ambiguous", lines: [1, 3, 5], more: false });
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

describe("bounded work on hostile input (#3902 review)", () => {
	const timed = <T,>(f: () => T): [T, number] => {
		const t0 = performance.now();
		const r = f();
		return [r, performance.now() - t0];
	};
	test("20k duplicate lines: capped report, short text, under 200 ms", () => {
		const big = "dup();\n".repeat(20000);
		const [t, ms] = timed(() => locateEdit(big, "dup();"));
		expect(ms).toBeLessThan(200);
		expect(t).toMatchObject({ kind: "ambiguous", more: true });
		const text = editRefusal(t, "x.ts") as string;
		expect(text).toContain("matches 20+ times");
		expect(text.length).toBeLessThan(600);
	});
	test("20k duplicates with a startLine near the end finds the copy fast", () => {
		const big = "dup();\n".repeat(20000);
		const [t, ms] = timed(() => locateEdit(big, "dup();", 19990));
		expect(ms).toBeLessThan(200);
		expect(t).toEqual({ kind: "ok", idx: 19989 * 7 });
	});
	test("1 MB of 'a' with oldText 'aa': overlapping matches stop at 20, under 200 ms", () => {
		const big = "a".repeat(1_000_000);
		const [t, ms] = timed(() => locateEdit(big, "aa"));
		expect(ms).toBeLessThan(200);
		expect(t).toMatchObject({ kind: "ambiguous", more: true });
		expect((t as { lines: number[] }).lines).toHaveLength(20);
	});
	test("1 MB of 'a', startLine past the end, still bounded", () => {
		const big = "a".repeat(1_000_000);
		const [t, ms] = timed(() => locateEdit(big, "aa", 5));
		expect(ms).toBeLessThan(200);
		expect(t).toMatchObject({ kind: "none-after", more: true });
		expect((t as { lines: number[] }).lines).toHaveLength(20);
		expect((editRefusal(t, "x") as string).length).toBeLessThan(600);
	});
	test("a 10k-char path is clipped in the refusal text", () => {
		const t = locateEdit("a\na\n", "a");
		expect((editRefusal(t, "p".repeat(10000)) as string).length).toBeLessThan(700);
	});
	test("overlapping 'aa' in 'aaa' is ambiguous", () => {
		expect(locateEdit("aaa", "aa").kind).toBe("ambiguous");
	});
	test("log record clips the path and keeps at most 20 lines", () => {
		const t = locateEdit("dup\n".repeat(500), "dup");
		logEditRefusal(t, "q".repeat(5000), 3);
		const rec = logLines()[0];
		expect(rec.path.length).toBeLessThan(250);
		expect(rec.lines).toHaveLength(20);
		expect(rec.more).toBe(true);
	});
	test("the log rotates past 1 MB", () => {
		const d = path.join(dir, ".8gent");
		fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(path.join(d, "edit-ambiguous.jsonl"), "x".repeat(1_100_000));
		logEditRefusal(locateEdit("a\na\n", "a"), "r.ts", 1);
		expect(fs.existsSync(path.join(d, "edit-ambiguous.jsonl.1"))).toBe(true);
		expect(fs.statSync(path.join(d, "edit-ambiguous.jsonl")).size).toBeLessThan(1000);
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
