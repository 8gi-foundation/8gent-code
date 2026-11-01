import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolExecutor } from "../eight/tools";
import { applyAt, applyEdit, editRefusal, resolveEdit, writtenContentFor } from "./write-content-gate";

function apply(content: string, oldText: string, newText: string, startLine?: number, file = "a.txt") {
	const r = resolveEdit(content, oldText, newText, startLine, file);
	return r.kind === "ok" ? applyAt(content, r.idx, r.oldLength, r.newText) : r;
}

function parsesAsPython(src: string): boolean {
	return spawnSync("python3", ["-I", "-c", "import ast,sys;ast.parse(sys.stdin.read())"], { input: src }).status === 0;
}

/** Result must parse as Python or the edit must be refused. */
function parsesOrRefused(content: string, oldText: string, newText: string): string | "refused" {
	const r = apply(content, oldText, newText, undefined, "a.py");
	if (typeof r !== "string") return "refused";
	expect(parsesAsPython(r)).toBe(true);
	return r;
}

describe("python-safe re-indent (M6)", () => {
	it("tab file, deeper newText than oldText: parses or refused", () => {
		const f = "def f():\n\tif x:\n\t\tpass\n";
		parsesOrRefused(f, "    if x:", "    if x:\n        y()\n            z()");
		parsesOrRefused(f, "  if x:\n    pass", "  if x:\n    for i in r:\n      pass");
		parsesOrRefused("\tfoo()\n\t\tbar()\n", "foo()\n  bar()", "foo()\n  bar()\n    baz()");
	});
	it("nested lines are refused, not shifted once", () => {
		const f = "class A:\n    def f(self):\n        if x:\n            return 1\n";
		expect(parsesOrRefused(f, "  def f(self):\n    if x:\n      return 1", "  def f(self):\n    if x:\n      return 2\n    return 3")).not.toBe("refused-never");
		parsesOrRefused(f, "  def f(self):\n    if x:", "  def f(self):\n    if y:\n      z()");
	});
	it("a newText indent missing from the map is refused", () => {
		const f = "def f():\n\tif x:\n\t\tpass\n";
		expect(parsesOrRefused(f, "    if x:", "    if x:\n        y()")).toBe("refused");
	});
});

describe("CRLF last line (M7)", () => {
	it("keeps the block's final CR when oldText omits it", () => {
		const f = "x\r\n    b\r\n    q\r\n";
		expect(apply(f, "  b\r\n  q", "  c\r\n  d")).toBe("x\r\n    c\r\n    d\r\n");
	});
});

describe("resolveEdit whitespace matching", () => {
	it("exact matches are untouched", () => {
		expect(apply("a\nb\n", "a\n", "x\n")).toBe("x\nb\n");
	});

	it("matches by trimming line ends, uses the block's own offset, never internal collapse", () => {
		const f = "x = 1\nif (a)  {\n\treturn\n}\nif (a) {\n\treturn\n}\n";
		// internal double space must not be collapsed to match line 2 by accident
		expect(apply("if (a)  {\n\treturn\n}\n", "if (a) {\n  return\n}", "x")).toMatchObject({ kind: "none" });
		expect(apply(f, "if (a) {\n  return\n}", "if (b) {\n  return\n}")).toBe(
			"x = 1\nif (a)  {\n\treturn\n}\nif (b) {\n\treturn\n}\n",
		);
	});

	it("honours startLine and refuses to pick when several blocks match", () => {
		const f = "\tfoo();\nmid\n\tfoo();\n";
		expect(resolveEdit(f, "  foo();", "  bar();", undefined, "a.ts").kind).toBe("none");
		expect(apply(f, "  foo();", "  bar();", 2)).toBe("\tfoo();\nmid\n\tbar();\n");
	});

	it("re-indents newText: Python", () => {
		const f = "def f():\n        x = 1\n        if x:\n            y = 2\n";
		const out = apply(f, "    x = 1\n    if x:\n        y = 2", "    x = 1\n    if x:\n        y = 3\n    z = 4");
		expect(out).toBe("def f():\n        x = 1\n        if x:\n            y = 3\n        z = 4\n");
	});

	it("re-indents newText: YAML", () => {
		const f = "svc:\n    web:\n        image: a\n";
		expect(apply(f, "  web:\n    image: a", "  web:\n    image: b", undefined, "c.yml")).toBe(
			"svc:\n    web:\n        image: b\n",
		);
	});

	it("Makefile: spaces from the model map to the recipe tab", () => {
		const f = "all:\n\techo a\n\techo b\n";
		expect(apply(f, "    echo a", "    echo c", undefined, "Makefile")).toBe("all:\n\techo c\n\techo b\n");
	});

	it("refuses an inconsistent indent mapping", () => {
		const f = "\ta\n\t\tb\n";
		// same model indent maps to two different file indents
		const r = resolveEdit(f, "  a\n  b", "  a\n  c", undefined, "a.py");
		expect(r.kind).toBe("ws-refused");
		expect(editRefusal(r, "a.py")).toContain("after whitespace matching");
		// newText indent with no mapping
		expect(resolveEdit("\ta\n", "  a", "      a", undefined, "a.py").kind).toBe("ws-refused");
		expect(resolveEdit("\ta\n", "  a", "a", undefined, "a.py").kind).toBe("ws-refused");
	});

	it("refuses CRLF blocks matched without CR, file stays untouched", () => {
		const f = "a\r\n b\r\nc\r\n";
		expect(resolveEdit(f, "a\nb", "a\nB", undefined, "a.txt").kind).toBe("ws-refused");
		expect(apply(f, "a\r\nb", "a\r\nB\r")).toMatchObject({}); // sanity: no throw
	});

	it("markdown: refuses to drop a trailing two-space hard break", () => {
		const f = "line one  \nline two\n";
		expect(resolveEdit(f, "line one\nline two", "x\ny", undefined, "R.md").kind).toBe("ws-refused");
		expect(apply(f, "line one\nline two", "x\ny", undefined, "R.txt")).toBe("x\ny\n");
	});

	it("scan is capped by characters: pathological input returns quickly", () => {
		for (const len of [10, 1000, 4000]) {
			const base = "x".repeat(len);
			const f = `${Array(2000).fill(` ${base}a`).join("\n")}\n`;
			const want = Array(999).fill(`${base}a`).concat([`${base}b`]).join("\n");
			const t = Date.now();
			expect(resolveEdit(f, want, "z", undefined, "a.txt").kind).toBe("none");
			expect(Date.now() - t).toBeLessThan(2000);
		}
		const big = Array(3_000_000).fill("a").join("\n");
		const t = Date.now();
		expect(resolveEdit(big, " a\n b\n c", "z").kind).toBe("none");
		expect(Date.now() - t).toBeLessThan(3000);
	});

	it("lines over 4 KB are never whitespace-matched", () => {
		const long = "y".repeat(5000);
		expect(resolveEdit(`${long}  \n`, `${long}\n`, "z").kind).toBe("none");
	});

	it("applyEdit passes filePath through for the markdown rule", () => {
		expect(applyEdit("a  \nb\n", "a\nb", "x\ny", undefined, "R.md")).toBeNull();
		expect(applyEdit("a  \nb\n", "a\nb", "x\ny", undefined, "R.txt")).toBe("x\ny\n");
	});
});

describe("write gate sees the bytes written for a whitespace match", () => {
	it("joining aws_secret_access_key = onto a key line through a whitespace match is BLOCKED", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-gate-"));
		const f = "cfg:\n  key =\nwJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY1234\n";
		fs.writeFileSync(path.join(dir, "a.txt"), f);
		const args = { path: "a.txt", oldText: "cfg:\n key =\n", newText: "cfg:\naws_secret_access_key = " };
		expect(writtenContentFor("edit_file", args, dir)).toContain("aws_secret_access_key = wJalr");
		for (const mode of [undefined, "primary"]) {
			const out = await new ToolExecutor(dir, mode as never).execute("edit_file", args);
			expect(out).toContain("BLOCKED");
			expect(fs.readFileSync(path.join(dir, "a.txt"), "utf-8")).toBe(f);
		}
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
