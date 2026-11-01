import { describe, expect, test } from "bun:test";
import { blockRows, parseBlocks, tableLines } from "./inline-markdown.js";

const md =
	"| Provider | Model | Latency |\n|---|---|---|\n| 8gent | eight-1.0-q3:14b | 120ms |\n| openrouter | meta-llama/llama-3.3-70b-instruct:free | 840ms |";

describe("pipe tables", () => {
	const block = parseBlocks(md)[0];
	test("parsed as one table block", () => {
		expect(block.kind).toBe("table");
	});
	test("wide enough: aligned grid under a rule, no pipes", () => {
		if (block.kind !== "table") throw new Error("not a table");
		const lines = tableLines(block, 100).map((l) => l.text);
		expect(lines.length).toBe(4);
		expect(lines.join("\n")).not.toContain("|");
		expect(lines[3].startsWith("openrouter  meta-llama/llama-3.3-70b-instruct:free  840ms")).toBe(
			true,
		);
	});
	test("narrow: one record per row, every cell whole, row count matches blockRows", () => {
		if (block.kind !== "table") throw new Error("not a table");
		const lines = tableLines(block, 34).map((l) => l.text);
		expect(lines).toContain("Provider  8gent");
		expect(lines.join("\n")).toContain("eight-1.0-q3:14b");
		expect(blockRows(block, 34)).toBe(lines.length);
	});
});
