/**
 * #3472: anchored edits. Hashes are deterministic, an anchor replaces exactly
 * the named line or block, and a stale anchor refuses without writing.
 */
import { describe, expect, test } from "bun:test";
import {
	HASHLINE_EDIT_DESC,
	HASHLINE_READ_DESC,
	anchoredEditMessage,
	applyAnchoredEdit,
	hashLines,
	hashlineEnabled,
	lineHash,
} from "./edit-anchor";

const FILE = "const a = 1;\nconst b  =  `x   y`;   // aligned\nconst c = 3;\n";
const anchorOf = (text: string, line: number) => `${line}#${lineHash(text.split("\n")[line - 1])}`;

describe("lineHash", () => {
	test("is deterministic, 4 base32 chars, and differs on a whitespace change", () => {
		expect(lineHash("const a = 1;")).toBe(lineHash("const a = 1;"));
		expect(lineHash("const a = 1;")).toMatch(/^[a-z2-7]{4}$/);
		expect(lineHash("const a = 1;")).not.toBe(lineHash("const a  = 1;"));
		expect(lineHash("")).toMatch(/^[a-z2-7]{4}$/);
	});

	test("hashLines prints the cat -n gutter with #hash after the number", () => {
		expect(hashLines(["x", "y"], 9)).toBe(`     9#${lineHash("x")}\tx\n    10#${lineHash("y")}\ty`);
	});
});

describe("applyAnchoredEdit", () => {
	test("replaces one line without copying its bytes", () => {
		const edit = applyAnchoredEdit(FILE, anchorOf(FILE, 2), "const b = 2;", "f.ts");
		expect(edit.ok).toBe(true);
		if (edit.ok) expect(edit.content).toBe("const a = 1;\nconst b = 2;\nconst c = 3;\n");
	});

	test("replaces a block named by every line's anchor, and accepts a copied row", () => {
		const anchors = `${anchorOf(FILE, 1)}\tconst a = 1;, ${anchorOf(FILE, 2)}`;
		const edit = applyAnchoredEdit(FILE, anchors, "one\ntwo\nthree\n", "f.ts");
		expect(edit.ok).toBe(true);
		if (edit.ok) {
			expect(edit.content).toBe("one\ntwo\nthree\nconst c = 3;\n");
			const msg = anchoredEditMessage("/w/f.ts", edit);
			expect(msg).toContain("Replaced lines 1-2 (2) with 3 line(s).");
			expect(msg).toContain("add 1 to their anchor numbers");
			expect(msg).toContain(`     3#${lineHash("three")}\tthree`);
		}
	});

	test("an array of anchors works the same as a comma list", () => {
		const edit = applyAnchoredEdit(FILE, [anchorOf(FILE, 2), anchorOf(FILE, 3)], "", "f.ts");
		expect(edit.ok && edit.content).toBe("const a = 1;\n");
	});

	test("a stale hash refuses and names the line", () => {
		const changed = FILE.replace("const b", "let b");
		const edit = applyAnchoredEdit(changed, anchorOf(FILE, 2), "x", "f.ts");
		expect(edit.ok).toBe(false);
		if (!edit.ok) {
			expect(edit.error).toContain("line 2 of f.ts changed since read_file");
			expect(edit.error).toContain("Nothing was written");
		}
	});

	test("refuses a gap in a block, a line past the end, no anchor, and a pasted gutter", () => {
		const gap = applyAnchoredEdit(FILE, `${anchorOf(FILE, 1)},${anchorOf(FILE, 3)}`, "x", "f.ts");
		expect(!gap.ok && gap.error).toContain("consecutive");
		const past = applyAnchoredEdit(FILE, "4#aaaa", "x", "f.ts");
		expect(!past.ok && past.error).toContain("past the end");
		const none = applyAnchoredEdit(FILE, "line two", "x", "f.ts");
		expect(!none.ok && none.error).toContain("no N#hash anchor");
		const gutter = applyAnchoredEdit(FILE, anchorOf(FILE, 1), hashLines(["x"], 1), "f.ts");
		expect(!gutter.ok && gutter.error).toContain("N#hash prefix");
	});

	test("CRLF lines keep their carriage return", () => {
		const crlf = "a\r\nb\r\n";
		const edit = applyAnchoredEdit(crlf, `1#${lineHash("a\r")}`, "z", "f.txt");
		expect(edit.ok && edit.content).toBe("z\r\nb\r\n");
	});
});

describe("flag and descriptions", () => {
	test("only EIGHT_EDIT_FORMAT=hashline turns it on", () => {
		expect(hashlineEnabled({})).toBe(false);
		expect(hashlineEnabled({ EIGHT_EDIT_FORMAT: "Hashline" })).toBe(false);
		expect(hashlineEnabled({ EIGHT_EDIT_FORMAT: "hashline" })).toBe(true);
	});

	test("each first sentence fits 140 chars and names the required parameters", () => {
		for (const [desc, words] of [
			[HASHLINE_READ_DESC, ["path"]],
			[HASHLINE_EDIT_DESC, ["anchor", "path", "newText", "in place"]],
		] as const) {
			const first = desc.split(/(?<=\.)\s/)[0];
			expect(first.length).toBeLessThanOrEqual(140);
			for (const w of words) expect(first).toContain(w);
		}
	});
});
