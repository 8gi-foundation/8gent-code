import { describe, expect, test } from "bun:test";
import { clipboardSequence, copyText, nativeCopyArgv } from "./copy-answer.js";
import {
	CLICK_SLOP,
	MULTI_CLICK_MS,
	TextSelection,
	copiedNotice,
	extractText,
	osc52,
	paintSelection,
	sliceCells,
	wordAt,
} from "./text-selection.js";

const SCREEN = ["hello brave world", "second line here", "中文 text"].join("\n");

function make(now: { t: number } = { t: 0 }) {
	return {
		sel: new TextSelection(
			() => SCREEN,
			() => now.t,
		),
		now,
	};
}

describe("extractText and cells", () => {
	test("rows are trimmed and the drag may run backwards", () => {
		expect(extractText(SCREEN, { x0: 6, y0: 0, x1: 2, y1: 1 })).toBe("brave world\nsec");
		expect(sliceCells("中b", 2, 3)).toBe("b");
	});
	test("wordAt finds the word, skips spaces, leaves the trailing dot", () => {
		expect(wordAt("hello brave world", 8)).toEqual({ from: 6, to: 11 });
		expect(wordAt("hello brave world", 5)).toBeNull();
		expect(wordAt("see src/app.tsx.", 6)).toEqual({ from: 4, to: 15 });
		expect(wordAt("中文 text", 1)).toEqual({ from: 0, to: 4 });
	});
});

describe("TextSelection", () => {
	test("a drag copies the covered text and highlights it until cleared", () => {
		const { sel } = make();
		sel.press(6, 0);
		sel.drag(3, 1);
		expect(sel.range).toEqual({ x0: 6, y0: 0, x1: 3, y1: 1 });
		expect(sel.release(3, 1)).toEqual({ kind: "copy", text: "brave world\nseco" });
		expect(sel.range).not.toBeNull();
		expect(sel.clear()).toBe(true);
		expect(sel.range).toBeNull();
		expect(sel.clear()).toBe(false);
	});

	test("movement under the slop is a click: nothing selected, nothing copied", () => {
		const { sel } = make();
		sel.press(4, 0);
		sel.drag(4 + CLICK_SLOP - 1, 0);
		expect(sel.range).toBeNull();
		expect(sel.release(4 + CLICK_SLOP - 1, 0)).toEqual({ kind: "click" });
	});

	test("a drag that wanders back near the start still copies once it left the slop", () => {
		const { sel } = make();
		sel.press(0, 0);
		sel.drag(9, 0);
		sel.drag(1, 0);
		expect(sel.release(1, 0)).toEqual({ kind: "copy", text: "he" });
	});

	test("double click selects the word, triple the line, a fourth starts over", () => {
		const { sel, now } = make();
		sel.press(8, 0);
		sel.release(8, 0);
		now.t += 100;
		sel.press(8, 0);
		expect(sel.release(8, 0)).toEqual({ kind: "copy", text: "brave" });
		now.t += 100;
		sel.press(8, 0);
		expect(sel.release(8, 0)).toEqual({ kind: "copy", text: "hello brave world" });
		now.t += 100;
		sel.press(8, 0);
		expect(sel.release(8, 0)).toEqual({ kind: "click" });
	});

	test("two clicks too far apart in time or space stay single clicks", () => {
		const { sel, now } = make();
		sel.press(8, 0);
		sel.release(8, 0);
		now.t += MULTI_CLICK_MS + 1;
		sel.press(8, 0);
		expect(sel.release(8, 0)).toEqual({ kind: "click" });
		now.t += 100;
		sel.press(14, 1);
		expect(sel.release(14, 1)).toEqual({ kind: "click" });
	});

	test("double click on a space selects nothing", () => {
		const { sel, now } = make();
		sel.press(5, 0);
		sel.release(5, 0);
		now.t += 50;
		sel.press(5, 0);
		expect(sel.release(5, 0)).toEqual({ kind: "none" });
		expect(sel.range).toBeNull();
	});

	test("a press starts fresh: the old highlight goes", () => {
		const { sel } = make();
		sel.press(0, 0);
		sel.drag(5, 0);
		sel.release(5, 0);
		sel.press(0, 2);
		expect(sel.range).toBeNull();
	});
});

describe("paint and clipboard", () => {
	test("paintSelection restores the row styled, then inverts the covered cells", () => {
		const raw = "\x1b[31mhello\x1b[39m brave\nsecond";
		const plain = "hello brave\nsecond";
		const out = paintSelection(raw, plain, null, { x0: 6, y0: 0, x1: 2, y1: 1 });
		expect(out.startsWith("\x1b7")).toBe(true);
		expect(out.endsWith("\x1b8")).toBe(true);
		expect(out).toContain("\x1b[1;1H\x1b[31mhello");
		expect(out).toContain("\x1b[1;7H\x1b[7mbrave\x1b[0m");
		expect(out).toContain("\x1b[2;1H\x1b[7msec\x1b[0m");
	});
	test("clearing repaints without any reverse video", () => {
		const out = paintSelection("abc", "abc", { x0: 0, y0: 0, x1: 1, y1: 0 }, null);
		expect(out).toContain("\x1b[1;1Habc");
		expect(out).not.toContain("\x1b[7m");
	});
	test("copy goes out as OSC 52, plus the platform command", () => {
		const written: string[] = [];
		const ran: string[][] = [];
		const run = (argv: string[]) => {
			ran.push(argv);
			return true;
		};
		copyText("héllo", {
			write: (s) => written.push(s),
			env: {},
			platform: "darwin",
			runNative: run,
		});
		expect(written).toEqual([osc52("héllo")]);
		expect(written[0]).toBe(`\x1b]52;c;${Buffer.from("héllo").toString("base64")}\x07`);
		expect(clipboardSequence("x", {})).toBe(osc52("x"));
		expect(ran).toEqual([["pbcopy"]]);
	});
	test("native fallback by platform: pbcopy, wl-copy, clip.exe (ASCII only)", () => {
		expect(nativeCopyArgv("darwin", {})).toEqual(["pbcopy"]);
		expect(nativeCopyArgv("linux", { WAYLAND_DISPLAY: "w0" })).toEqual(["wl-copy"]);
		expect(nativeCopyArgv("win32", {}, "plain")).toEqual(["clip.exe"]);
		expect(nativeCopyArgv("win32", {}, "中")).toBeNull();
		expect(nativeCopyArgv("darwin", { SSH_TTY: "x" })).toBeNull();
	});
	test("the notice", () => {
		expect(copiedNotice(1)).toBe("Copied 1 character");
		expect(copiedNotice(22)).toBe("Copied 22 characters");
	});
});

describe("help", () => {
	test("/help names the terminal bypass", async () => {
		const { formatSlashHelp } = await import("./slash-commands.js");
		for (const all of [false, true]) {
			const h = formatSlashHelp(all);
			expect(h).toContain("Option-drag");
			expect(h).toContain("Shift-drag");
		}
	});
});
