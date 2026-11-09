/**
 * The inline diff through Ink (design review of #109): tabs keep their last
 * character, a wrapped row keeps its text clear of the +/- mark, and the header
 * reads first.
 */

import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import type { Message } from "../../app.js";
import { diffRows, safeForScreen } from "../../lib/session-changes.js";
import { MessageList, estimateMessageRowsForTest } from "../message-list.js";

const at = new Date("2026-11-09T12:00:00Z");
const diffMsg = (content: string): Message => ({
	id: "d1",
	role: "system",
	content,
	timestamp: at,
});

function draw(content: string, cols: number): string {
	return renderToString(
		<MessageList
			messages={[diffMsg(content)]}
			animateTyping={false}
			showAnimations={false}
			scrollEnabled={false}
			contentWidth={cols - 4}
			rowBudget={80}
			turnRunning={false}
		/>,
		{ columns: cols },
	);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping colour codes is the point
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("tabs in a diff", () => {
	test("safeForScreen leaves no tab", () => {
		expect(safeForScreen("diff a.ts  +1 -0\n+\tconst x = 1;")).not.toContain("\t");
		expect(safeForScreen("+\tconst x = 1;")).toBe("+  const x = 1;");
	});

	test("the last character of a tabbed row is drawn at 52 and 160 columns", () => {
		const text = safeForScreen("diff a.ts  +2 -0\n@@ -1,0 +1,2 @@\n+\tconst x = 1;\n+\t\treturn x;");
		for (const cols of [52, 160]) {
			const out = plain(draw(text, cols));
			expect(out).toContain("const x = 1;");
			expect(out).toContain("return x;");
		}
	});
});

describe("a wrapped row keeps its text clear of the mark", () => {
	const long = `${"word ".repeat(30)}end`;
	const text = ["diff a.ts  +1 -1", "@@ -1,1 +1,1 @@", `-${long}`, `+${long}`].join("\n");

	for (const cols of [40, 52]) {
		test(`at ${cols} columns only the first row carries the mark and the rest align under the text`, () => {
			const rows = plain(draw(text, cols)).split("\n");
			const first = rows.findIndex((r) => /^\s*\+ ?word/.test(r));
			expect(first).toBeGreaterThan(-1);
			const textCol = rows[first].indexOf("word");
			let continuation = 0;
			for (let i = first + 1; i < rows.length; i++) {
				const r = rows[i];
				if (!/\S/.test(r) || /^\s*[─-]{3}/.test(r)) break;
				continuation++;
				// Never under the mark: the mark columns are blank. (Ink may keep one
				// space of the wrapped words, so the text starts at the column or one past it.)
				expect(r.slice(0, textCol).trim()).toBe("");
				expect(r.search(/\S/)).toBeGreaterThanOrEqual(textCol);
				expect(r.search(/\S/)).toBeLessThanOrEqual(textCol + 1);
			}
			expect(continuation).toBeGreaterThan(0);
		});
	}

	test("the row estimate holds with the mark column", () => {
		for (const cols of [40, 52, 160]) {
			const drawn = plain(draw(text, cols)).split("\n");
			const used = drawn.length - drawn.slice().reverse().findIndex((r) => /\S/.test(r)) ;
			const est = estimateMessageRowsForTest(diffMsg(text), cols - 4);
			// The estimate is a budget: never short of what is drawn, and not far over.
			expect(est).toBeGreaterThanOrEqual(used - 1);
			expect(est).toBeLessThanOrEqual(used + 3);
		}
	});
});

describe("the header", () => {
	test("parses into path, +N and -M so each can take its own colour", () => {
		const [header] = diffRows("diff src/a.ts (new file)  +12 -3\n@@ -1 +1 @@");
		expect(header).toEqual({
			kind: "header",
			mark: "",
			text: "diff src/a.ts (new file)",
			added: "+12",
			removed: "-3",
		});
	});

	test("is one row, ahead of the hunk, with the stats beside the path", () => {
		const out = plain(draw("diff a.ts  +1 -1\n@@ -1,1 +1,1 @@\n-a\n+b", 80)).split("\n");
		const row = out.findIndex((r) => r.includes("diff a.ts"));
		expect(row).toBeGreaterThan(-1);
		expect(out[row]).toContain("+1");
		expect(out[row]).toContain("-1");
		expect(out.findIndex((r) => r.includes("@@"))).toBeGreaterThan(row);
	});

	test("a row that merely starts with 'diff' inside a file is not a header", () => {
		expect(diffRows("+diff a.ts  +1 -1")[0]?.kind).toBe("add");
	});
});
