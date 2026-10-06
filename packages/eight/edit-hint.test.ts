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
