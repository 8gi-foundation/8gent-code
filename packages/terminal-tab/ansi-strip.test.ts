/**
 * Tests for @8gent/terminal-tab — ansi-strip.
 *
 * Strategy: pure function tests. Each escape sequence family
 * gets at least one positive case (gets stripped) and the SGR
 * family gets a "keep" case (color must survive).
 */

import { describe, expect, it } from "bun:test";
import { hasAltScreenEnter, hasAltScreenExit, stripControl } from "./ansi-strip.js";

describe("stripControl — SGR (color/style) is preserved", () => {
	it("keeps the SGR red+bold prefix and reset suffix", () => {
		const input = "\x1b[1;31mERROR\x1b[0m";
		expect(stripControl(input)).toBe(input);
	});

	it("keeps SGR even when surrounded by cursor moves", () => {
		const input = "\x1b[10;5H\x1b[32mok\x1b[0m\x1b[2J";
		// cursor moves and clear should be removed; SGR stays
		expect(stripControl(input)).toBe("\x1b[32mok\x1b[0m");
	});
});

describe("stripControl — cursor moves are removed", () => {
	it("strips CSI cursor-position H", () => {
		expect(stripControl("\x1b[10;5Hhello")).toBe("hello");
	});

	it("strips CUU/CUD/CUF/CUB single-axis moves", () => {
		expect(stripControl("\x1b[5Aup\x1b[3Bdown\x1b[2Cright\x1b[1Dleft")).toBe("updownrightleft");
	});

	it("strips save/restore cursor (DECSC / DECRC)", () => {
		expect(stripControl("\x1b7saved\x1b8")).toBe("saved");
	});
});

describe("stripControl — clear and erase sequences are removed", () => {
	it("strips clear-screen \\x1b[2J", () => {
		expect(stripControl("\x1b[2Jclear")).toBe("clear");
	});

	it("strips erase-in-line \\x1b[K and \\x1b[2K", () => {
		expect(stripControl("\x1b[Ka\x1b[2Kb")).toBe("ab");
	});
});

describe("stripControl — DEC private modes (?-prefixed) are removed", () => {
	it("strips bracketed-paste enable/disable", () => {
		expect(stripControl("\x1b[?2004hX\x1b[?2004l")).toBe("X");
	});

	it("strips alt-screen enable/disable", () => {
		expect(stripControl("\x1b[?1049hbody\x1b[?1049l")).toBe("body");
	});

	it("strips cursor visibility toggles", () => {
		expect(stripControl("\x1b[?25l\x1b[?25h.")).toBe(".");
	});
});

describe("stripControl — OSC and DCS sequences are removed", () => {
	it("strips OSC title set terminated by BEL", () => {
		expect(stripControl("\x1b]0;my title\x07after")).toBe("after");
	});

	it("strips OSC title set terminated by ST (\\x1b\\\\)", () => {
		expect(stripControl("\x1b]0;t\x1b\\after")).toBe("after");
	});
});

describe("stripControl — carriage returns are normalised", () => {
	it("strips standalone carriage returns (progress-bar overwrite)", () => {
		expect(stripControl("loading\rdone\n")).toBe("done\n");
	});

	it("keeps newlines untouched", () => {
		expect(stripControl("line1\nline2\n")).toBe("line1\nline2\n");
	});
});

describe("stripControl — degenerate inputs", () => {
	it("returns empty string unchanged", () => {
		expect(stripControl("")).toBe("");
	});

	it("returns plain ASCII unchanged", () => {
		expect(stripControl("just text")).toBe("just text");
	});

	it("does not mangle a lone ESC at end of buffer", () => {
		// partial sequence at chunk boundary — keep it for the next chunk to repair
		expect(stripControl("ok\x1b")).toBe("ok\x1b");
	});
});

describe("hasAltScreenEnter / hasAltScreenExit — detection helpers", () => {
	it("detects alt-screen enable", () => {
		expect(hasAltScreenEnter("foo\x1b[?1049hbar")).toBe(true);
		expect(hasAltScreenEnter("\x1b[?47h")).toBe(true); // legacy
		expect(hasAltScreenEnter("plain text")).toBe(false);
	});

	it("detects alt-screen disable", () => {
		expect(hasAltScreenExit("foo\x1b[?1049lbar")).toBe(true);
		expect(hasAltScreenExit("\x1b[?47l")).toBe(true);
		expect(hasAltScreenExit("\x1b[?1049h")).toBe(false);
	});
});
