import { describe, expect, test } from "bun:test";
import { drawsColour, glyphs, unicodeRich } from "./term-caps.js";

describe("terminal glyph capability", () => {
	test("modern terminals are unicode-rich", () => {
		expect(unicodeRich({ TERM: "xterm-256color" }, "darwin")).toBe(true);
		expect(unicodeRich({ WT_SESSION: "x" }, "win32")).toBe(true);
		expect(unicodeRich({ TERM_PROGRAM: "vscode" }, "win32")).toBe(true);
	});

	test("the Linux console, the legacy Windows console and EIGHT_ASCII fall back", () => {
		expect(unicodeRich({ TERM: "linux" }, "linux")).toBe(false);
		expect(unicodeRich({}, "win32")).toBe(false);
		expect(unicodeRich({ EIGHT_ASCII: "1", TERM: "xterm-256color" }, "darwin")).toBe(false);
	});

	test("every fallback glyph is plain ASCII and the same width", () => {
		const rich = glyphs({ TERM: "xterm" }, "darwin");
		const ascii = glyphs({ TERM: "linux" }, "linux");
		expect(ascii.eight).toBe("8");
		expect(rich.eight).toBeNull();
		for (const key of ["ok", "pending", "fail", "blocked", "dot", "diamond", "rule", "bar"] as const) {
			expect(/^[\x20-\x7e]$/.test(ascii[key])).toBe(true);
			expect(ascii[key].length).toBe(rich[key].length);
		}
	});
});

describe("drawsColour (code chips need a tint to read as code)", () => {
	test("colour unless NO_COLOR is set or TERM is dumb", () => {
		expect(drawsColour({ TERM: "xterm-256color" })).toBe(true);
		expect(drawsColour({ NO_COLOR: "1" })).toBe(false);
		expect(drawsColour({ NO_COLOR: "" })).toBe(true);
		expect(drawsColour({ TERM: "dumb" })).toBe(false);
	});

	test("plain terminals get ASCII list bullets and code gutters", () => {
		expect(glyphs({ TERM: "linux" }, "linux")).toMatchObject({ bullet: "-", gutter: "|" });
		expect(glyphs({}, "darwin")).toMatchObject({ bullet: "•", gutter: "│" });
	});
});
