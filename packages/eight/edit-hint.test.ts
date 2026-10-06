import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolExecutor } from "./tools";
import { describe, expect, it } from "bun:test";
import { findClosestRegion, formatEditNotFound } from "./edit-hint";

const FILE = [
	"import { add } from './store';",
	"",
	"function main() {",
	"  const args = process.argv.slice(2);",
	"  if (args[0] === 'add') {",
	"    add(args[1]);",
	"  }",
	"}",
	"",
].join("\n");

describe("edit_file not-found hint", () => {
	it("returns the exact current text when the model used 3 spaces and the file has 2", () => {
		const oldText = "   const args = process.argv.slice(2);\n   if (args[0] === 'add') {";
		const msg = formatEditNotFound("src/cli.ts", FILE, oldText);
		expect(msg).toContain("Could not find the text to replace in src/cli.ts");
		expect(msg).toContain("differ only in whitespace");
		expect(msg).toContain("4:   const args = process.argv.slice(2);");
		expect(msg).toContain("5:   if (args[0] === 'add') {");
		expect(msg).toContain("  const args = process.argv.slice(2);\n  if (args[0] === 'add') {");
		expect(msg).toContain("Retry edit_file with this exact text; do not rewrite the file.");
	});

	it("falls back to the best fuzzy line window when words differ", () => {
		const r = findClosestRegion(FILE, "const args = process.argv.slice(3);\nif (args[0] === 'add') {");
		expect(r?.startLine).toBe(4);
		expect(r?.endLine).toBe(5);
		expect(r?.kind).toBe("fuzzy");
	});

	it("returns null when nothing resembles the text", () => {
		expect(findClosestRegion(FILE, "zzzz qqqq wwww")).toBeNull();
		expect(formatEditNotFound("a.ts", FILE, "zzzz qqqq wwww")).not.toContain("do not rewrite");
	});
});

describe("edit-hint wording and caps", () => {
	it("fuzzy wording asks to verify", () => {
		const msg = formatEditNotFound("a.ts", FILE, "const args = process.argv.slice(3);\nif (args[0] === 'add') {");
		expect(msg).toContain("closest match; verify it is what you meant");
		expect(msg).not.toContain("differ only in whitespace");
	});

	it("caps large regions at 40 lines with a truncated marker and one copy", () => {
		const big = Array.from({ length: 100 }, (_, i) => `  line number ${i} here ${"pad ".repeat(60)}`).join("\n");
		const old = big.replace(/^ {2}/gm, "   ");
		const msg = formatEditNotFound("big.ts", big, old);
		expect(msg).toContain("(truncated)");
		expect(Buffer.byteLength(msg)).toBeLessThan(5000);
		expect(msg.split("line number 0 here").length - 1).toBe(1);
	});
});

describe("edit-hint bounded work", () => {
	it("50k-line file + 2000-line near-miss returns within 200ms", () => {
		const file = Array.from({ length: 50_000 }, (_, i) => `  const v${i} = compute(${i});`).join("\n");
		const old = Array.from({ length: 2000 }, (_, i) => `   const v${i + 100} = compute(${i + 100}) // x`).join("\n");
		const t0 = performance.now();
		const msg = formatEditNotFound("big.ts", file, old);
		const ms = performance.now() - t0;
		console.log(`bounded-work timing: ${ms.toFixed(1)}ms`);
		expect(ms).toBeLessThan(200);
		expect(msg).toContain("Could not find the text to replace");
	});

	it("5-line whitespace miss on a 50k-line file still gets a hint fast", () => {
		const file = Array.from({ length: 50_000 }, (_, i) => `  const v${i} = compute(${i});`).join("\n");
		const old = [100, 101, 102].map((i) => `   const v${i} = compute(${i});`).join("\n");
		const t0 = performance.now();
		const msg = formatEditNotFound("big.ts", file, old);
		expect(performance.now() - t0).toBeLessThan(200);
		expect(msg).toContain("differ only in whitespace");
	});

	it("scrubs secrets in the echoed region and never splits a surrogate pair", () => {
		const key = "AKIA" + "ABCDEFGHIJKLMNOP";
		const f = `x = "${key}"\n`;
		const msg = formatEditNotFound("e.ts", f, `x  =  "${key}"`);
		expect(msg).not.toContain(key);
		const emoji = Array.from({ length: 3000 }, () => "😀").join("");
		const m2 = formatEditNotFound("e.ts", emoji, " " + emoji);
		expect(m2).not.toContain("\uFFFD");
		expect(m2).toContain("(truncated)");
	});
});

describe("ToolExecutor edit_file not-found", () => {
	it("returns the hint and leaves the file byte-identical", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-hint-"));
		const f = path.join(dir, "cli.ts");
		fs.writeFileSync(f, FILE);
		const before = fs.readFileSync(f);
		const out = await new ToolExecutor(dir).execute("edit_file", {
			path: "cli.ts",
			oldText: "   const args = process.argv.slice(2);\n   if (args[0] === 'add') {",
			newText: "x",
		});
		expect(out).toContain("Retry edit_file with this exact text; do not rewrite the file.");
		expect(out).toContain("  const args = process.argv.slice(2);\n  if (args[0] === 'add') {");
		expect(fs.readFileSync(f).equals(before)).toBe(true);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
