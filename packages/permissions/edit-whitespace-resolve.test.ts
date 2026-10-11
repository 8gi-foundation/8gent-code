import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolExecutor } from "../eight/tools";
import { applyAt, editRefusal, resolveEdit, writtenContentFor } from "./write-content-gate";

function apply(content: string, oldText: string, newText: string, startLine?: number, file = "a.txt") {
	const r = resolveEdit(content, oldText, newText, startLine, file);
	return r.kind === "ok" ? applyAt(content, r.idx, r.oldLength, r.newText) : r;
}

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
		expect(resolveEdit("\ta\n", "  a", "      a", undefined, "a.py").kind).toBe("ok");
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

	it("scan is capped: pathological input returns quickly", () => {
		const f = `${"x\n".repeat(400_000)}y\n`;
		const old = `${"x\n".repeat(2000)}z`;
		const t = Date.now();
		expect(resolveEdit(f, old, "q", undefined, "a.txt").kind).toBe("none");
		expect(Date.now() - t).toBeLessThan(2000);
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
