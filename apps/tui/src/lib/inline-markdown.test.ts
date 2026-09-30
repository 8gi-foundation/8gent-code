import { describe, expect, test } from "bun:test";
import {
	blockRows,
	hasMarkdown,
	markdownRows,
	parseBlocks,
	parseInline,
	spanText,
	chunkWord,
	layoutLines,
} from "./inline-markdown.js";

describe("parseInline", () => {
	test("code spans become padded chips", () => {
		expect(parseInline("run `bun test` now")).toEqual([
			{ text: "run " },
			{ text: " bun test ", code: true },
			{ text: " now" },
		]);
	});

	test("bold holding a code span (audit #6: **Researched `packages/decide`**)", () => {
		expect(parseInline("**Researched `packages/decide`** first")).toEqual([
			{ text: "Researched ", bold: true },
			{ text: " packages/decide ", code: true, bold: true },
			{ text: " first" },
		]);
	});

	test("__bold__ works too, and stray markers stay literal", () => {
		expect(parseInline("__done__ and 2 * 3 ** 4")).toEqual([{ text: "done", bold: true }, { text: " and 2 * 3 ** 4" }]);
		expect(parseInline("a ` lone tick")).toEqual([{ text: "a ` lone tick" }]);
	});

	test("*italic* with single stars; snake_case and arithmetic stay literal", () => {
		expect(parseInline("for *this* package")).toEqual([
			{ text: "for " },
			{ text: "this", italic: true },
			{ text: " package" },
		]);
		expect(parseInline("a*b*c and 2 * 3 * 4 and snake_case_name")).toEqual([
			{ text: "a*b*c and 2 * 3 * 4 and snake_case_name" },
		]);
	});

	test("without chips the backticks stay, so code still reads as code", () => {
		expect(spanText(parseInline("run `bun test`", { chips: false }))).toBe("run `bun test`");
	});
});

describe("parseBlocks", () => {
	test("lists get a marker, depth and lazy continuation", () => {
		const blocks = parseBlocks("Intro:\n- one\n  - nested `x`\n2. two\ncarries on\n\ntail");
		expect(blocks.map((b) => b.kind)).toEqual(["para", "item", "item", "item", "blank", "para"]);
		const [, a, b, c] = blocks as Array<Extract<(typeof blocks)[number], { kind: "item" }>>;
		expect([a.depth, a.marker]).toEqual([0, "•"]);
		expect([b.depth, b.marker]).toEqual([1, "•"]);
		expect([c.marker, spanText(c.spans)]).toEqual(["2.", "two carries on"]);
	});

	test("plain terminals get an ASCII bullet", () => {
		const [item] = parseBlocks("- one", { bullet: "-" });
		expect(item).toMatchObject({ kind: "item", marker: "-" });
	});

	test("fences keep indentation and the language; an open fence runs to the end", () => {
		expect(parseBlocks("```ts\n  const a = 1;\n```")).toEqual([
			{ kind: "code", lang: "ts", lines: ["  const a = 1;"] },
		]);
		expect(parseBlocks("see:\n```bash\nbun test")).toEqual([
			{ kind: "para", spans: [{ text: "see:" }] },
			{ kind: "code", lang: "bash", lines: ["bun test"] },
		]);
	});

	test("headings are bold paragraphs; blank runs collapse; edges trimmed", () => {
		const blocks = parseBlocks("\n\n## Root cause\n\n\n\nThe fix.\n\n");
		expect(blocks).toEqual([
			{ kind: "para", heading: true, spans: [{ text: "Root cause", bold: true }] },
			{ kind: "blank" },
			{ kind: "para", spans: [{ text: "The fix." }] },
		]);
	});

	test("a markdown-free reply is one paragraph per line, unchanged", () => {
		const text = "Apple\nBanana\nCherry";
		expect(hasMarkdown(text)).toBe(false);
		expect(parseBlocks(text).map((b) => (b.kind === "para" ? spanText(b.spans) : b.kind))).toEqual(
			text.split("\n"),
		);
	});
});

describe("row counts match the layout", () => {
	const rowsText = (spans: Parameters<typeof layoutLines>[0], w: number) =>
		layoutLines(spans, w).map((l) => spanText(l));

	test("words move whole; no wrapped row starts with a space (audit #12)", () => {
		expect(rowsText([{ text: "aaa bbb ccc" }], 7)).toEqual(["aaa bbb", "ccc"]);
		expect(rowsText([{ text: "aaa bbb ccc" }], 11)).toEqual(["aaa bbb ccc"]);
	});

	test("a chip is one unit: it moves to the next row whole, never split", () => {
		const spans = parseInline("so run `npm test` now");
		expect(rowsText(spans, 12)).toEqual(["so run", " npm test ", "now"]);
		for (const line of layoutLines(spans, 12)) {
			for (const s of line) expect([...s.text].length).toBeLessThanOrEqual(12);
		}
	});

	test("punctuation after a chip stays with it", () => {
		const rows = rowsText(parseInline("config lives in `package.json`."), 20);
		expect(rows).toEqual(["config lives in", " package.json ."]);
	});

	test("a word wider than the row is cut at its seams first", () => {
		expect(chunkWord("packages/decide/src/engine.ts", 12)).toEqual(["packages/", "decide/src/", "engine.ts"]);
		expect(chunkWord("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
	});

	test("a list item wraps at its hanging indent, not the column", () => {
		const [item] = parseBlocks("- aaaa bbbb cccc");
		// The text is 14 wide and the marker "• " takes 2 columns.
		expect(blockRows(item, 15)).toBe(2);
		expect(blockRows(item, 16)).toBe(1);
	});

	test("code wraps inside the gutter and counts its language row", () => {
		const [code] = parseBlocks("```bash\n" + "x".repeat(20) + "\n\n```");
		// gutter 2 of 12 cols: 10 per row. 20 chars = 2 rows, blank = 1, lang = 1.
		expect(blockRows(code, 12)).toBe(4);
	});

	test("markdownRows sums blocks, and never counts less than one row", () => {
		expect(markdownRows("", 40)).toBe(1);
		expect(markdownRows("Hi **there**\n\n- a\n- b", 40)).toBe(4);
	});
});
