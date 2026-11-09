/**
 * The inline diff through Ink (design review of #109): tabs keep their last
 * character, a wrapped row keeps its text clear of the +/- mark, and the header
 * reads first.
 */

import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import type { Message } from "../../app.js";
import { diffRowCount, diffRows, safeForScreen, wrapDiffText } from "../../lib/session-changes.js";
import { bubbleWidths } from "../../lib/chat-layout.js";
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

	for (const cols of [40, 52, 160]) {
		test(`at ${cols} columns every row of a line starts in the same column and no text is lost`, () => {
			const rows = plain(draw(text, cols)).split("\n");
			for (const mark of ["+", "-"]) {
				const first = rows.findIndex((r) => new RegExp(`^\\s*\\${mark} word`).test(r));
				expect(first).toBeGreaterThan(-1);
				const textCol = rows[first].indexOf("word");
				const pieces = [rows[first].slice(textCol)];
				for (let i = first + 1; i < rows.length; i++) {
					const r = rows[i];
					if (!/\S/.test(r) || /[+-] word|^\s*─/.test(r)) break;
					// Same column as row one, not one past it, and nothing under the mark.
					expect(r.slice(0, textCol).trim()).toBe("");
					expect(r[textCol]).not.toBe(" ");
					pieces.push(r.slice(textCol));
				}
				if (cols < 160) expect(pieces.length).toBeGreaterThan(1);
				// Joined, the rows are the source minus the single space at each break.
				expect(pieces.join(" ")).toBe(long);
			}
		});
	}

	test("a leading indent stays on the first row only; a long token is hard-broken", () => {
		expect(wrapDiffText("    const a = 1; const b = 2;", 20)).toEqual(["    const a = 1;", "const b = 2;"]);
		expect(wrapDiffText("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
		expect(wrapDiffText("ab cd", 5)).toEqual(["ab cd"]);
		expect(wrapDiffText("abc def", 3)).toEqual(["abc", "def"]);
		expect(wrapDiffText("", 10)).toEqual([""]);
	});

	test("the row estimate equals the rows drawn", () => {
		for (const cols of [40, 52, 160]) {
			const drawn = plain(draw(text, cols)).split("\n");
			const used = drawn.length - drawn.slice().reverse().findIndex((r) => /\S/.test(r));
			const wrap = bubbleWidths(cols - 4, "system").wrap;
			const est = estimateMessageRowsForTest(diffMsg(text), wrap);
			// The diff rows, two rule rows and the margin row: the margin is blank, so not in `used`.
			expect(diffRowCount(text, wrap) + 2).toBe(used);
			expect(est).toBe(used + 1);
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

describe("a long path keeps the stats beside it", () => {
	test("+N -M stay on the first row of the path, never on their own row", () => {
		const path = `${"dir/".repeat(14)}file.ts`;
		for (const cols of [40, 52]) {
			const rows = plain(draw(`diff ${path}  +12 -3\n@@ -1 +1 @@\n+x`, cols)).split("\n");
			const withStats = rows.filter((r) => /\+12 -3/.test(r));
			expect(withStats).toHaveLength(1);
			expect(withStats[0]).toContain("diff dir/");
			expect(rows.filter((r) => /^\s*\+12 -3\s*$/.test(r))).toHaveLength(0);
		}
	});
});
