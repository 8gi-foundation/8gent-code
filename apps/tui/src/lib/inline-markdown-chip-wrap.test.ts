import { describe, expect, test } from "bun:test";
import { layoutLines, parseInline } from "./inline-markdown.js";

const rowsOf = (text: string, w: number) =>
	layoutLines(parseInline(text), w).map((r) => r.map((s) => s.text).join(""));

describe("a code chip wider than the row", () => {
	test("breaks between its words, so a flag stays whole", () => {
		const rows = rowsOf("Start with `8gent daemon start --port 18789 --no-update` now", 36);
		expect(rows.some((r) => r.includes("--port"))).toBe(true);
		expect(rows.some((r) => r.includes("--no-update"))).toBe(true);
		expect(rows.every((r) => !r.endsWith("-") && !r.trim().startsWith("-no"))).toBe(true);
	});
	test("keeps the chip padding on every row", () => {
		const spans = layoutLines(parseInline("`aaaa bbbb cccc dddd`"), 12).flat();
		expect(spans.every((s) => s.text.startsWith(" ") && s.text.endsWith(" "))).toBe(true);
	});
	test("a single word wider than the row still breaks at a seam", () => {
		const rows = rowsOf("`https://registry.npmjs.org/some/long/path`", 20);
		expect(rows.length).toBeGreaterThan(1);
		expect(rows.every((r) => r.length <= 20)).toBe(true);
	});
});
