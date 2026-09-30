import { describe, expect, test } from "bun:test";
import {
	blockRows,
	hasMarkdown,
	markdownRows,
	parseBlocks,
	parseInline,
	spanText,
	chunkWord,
	clipSpans,
	layoutLines,
	plainInline,
} from "./inline-markdown.js";
import type { Block } from "./inline-markdown.js";

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

describe("plainInline and clipSpans (#3109): plan steps outside the chat", () => {
	test("plainInline drops the backticks and stars, keeps the words", () => {
		expect(plainInline("Read `packages/decide/index.ts` and **fix** it")).toBe(
			"Read packages/decide/index.ts and fix it",
		);
		expect(plainInline("`bun test` passes")).toBe("bun test passes");
		expect(plainInline("no markers here")).toBe("no markers here");
		// An unmatched backtick is the agent's own text: it stays.
		expect(plainInline("a lone ` tick")).toBe("a lone ` tick");
	});

	test("clipSpans fits the width exactly, a cut chip keeps its padding", () => {
		const spans = parseInline("run `packages/decide/index.ts` now");
		const whole = spanText(spans).length;
		expect(spanText(clipSpans(spans, whole))).toBe(spanText(spans));
		for (const w of [1, 3, 4, 6, 10, 20]) {
			const cut = clipSpans(spans, w);
			expect([...spanText(cut)].length).toBeLessThanOrEqual(w);
		}
		const cut = clipSpans(spans, 12);
		expect(cut.at(-1)).toEqual({ text: " packa… ", code: true });
		expect(spanText(cut)).toBe("run  packa… ");
	});
});

describe("hand-aligned lines keep their spaces (audit 2026-09-30, #6)", () => {
	const card = [
		"Found on this machine:",
		"  Provider  ollama",
		"  Models    qwen3.8:27b-mlx",
		"            llama3.2:3b",
		"            qwen3.6:27b",
	].join("\n");
	const rowText = (row: { text: string }[]) => row.map((s) => s.text).join("");
	const spansOf = (b: Block) => (b.kind === "para" || b.kind === "item" ? b.spans : []);

	test("an indented line is marked keepSpaces; prose is not", () => {
		const blocks = parseBlocks(card);
		expect(blocks[0]).toMatchObject({ kind: "para" });
		expect((blocks[0] as { keepSpaces?: boolean }).keepSpaces).toBeUndefined();
		for (const b of blocks.slice(1)) expect(b).toMatchObject({ kind: "para", keepSpaces: true });
	});

	test("the welcome card's models start in the same column", () => {
		const rows = parseBlocks(card)
			.slice(1)
			.map((b) => rowText(layoutLines(spansOf(b), 60, true)[0]));
		expect(rows).toEqual([
			"  Provider  ollama",
			"  Models    qwen3.8:27b-mlx",
			"            llama3.2:3b",
			"            qwen3.6:27b",
		]);
		const col = (r: string) => r.search(/\S+$/);
		expect(new Set(rows.slice(1).map(col)).size).toBe(1);
	});

	test("prose still collapses runs of spaces", () => {
		const [b] = parseBlocks("one  two   three");
		expect(rowText(layoutLines(spansOf(b), 60)[0])).toBe("one two three");
	});

	test("a kept line wraps without starting a row with spaces, and rows match the estimate", () => {
		const [b] = parseBlocks("  Models    qwen3.8:27b-mlx");
		const rows = layoutLines(spansOf(b), 14, true).map(rowText);
		expect(rows).toEqual(["  Models", "qwen3.8:27b-", "mlx"]);
		expect(markdownRows("  Models    qwen3.8:27b-mlx", 14)).toBe(rows.length);
	});

	test("an indented line under a list item is still its continuation", () => {
		const blocks = parseBlocks("- item\n  carries on");
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({ kind: "item" });
	});
});
