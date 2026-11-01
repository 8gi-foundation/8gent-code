import { describe, expect, test } from "bun:test";
import {
	clipboardSequence,
	copyReply,
	copyText,
	lastAnswer,
	nativeCopyArgv,
	osc52Fits,
} from "./copy-answer.js";
import { osc52 } from "./mouse-wiring.js";

describe("/copy (#3918 D7)", () => {
	test("lastAnswer takes the newest non-empty assistant message", () => {
		const msgs = [
			{ role: "assistant", content: "old" },
			{ role: "user", content: "q" },
			{ role: "assistant", content: "  new  " },
			{ role: "system", content: "note" },
			{ role: "assistant", content: "   " },
		];
		expect(lastAnswer(msgs)).toBe("new");
		expect(lastAnswer([{ role: "user", content: "q" }])).toBeNull();
		expect(lastAnswer([{ id: "setup-q-1", role: "assistant", content: "Your name?" }])).toBeNull();
	});

	test("OSC 52 is wrapped for tmux and screen", () => {
		expect(clipboardSequence("hi", {})).toBe(osc52("hi"));
		const tmux = clipboardSequence("hi", { TMUX: "/tmp/x" });
		expect(tmux.startsWith("\x1bPtmux;\x1b\x1b]52;c;")).toBeTrue();
		expect(tmux.endsWith("\x1b\\")).toBeTrue();
		expect(clipboardSequence("hi", { STY: "1.pts" })).toBe(`\x1bP${osc52("hi")}\x1b\\`);
	});

	test("native copy is local only and per platform", () => {
		expect(nativeCopyArgv("darwin", {})).toEqual(["pbcopy"]);
		expect(nativeCopyArgv("darwin", { SSH_CONNECTION: "1 2 3 4" })).toBeNull();
		expect(nativeCopyArgv("linux", { WAYLAND_DISPLAY: "wayland-0" })).toEqual(["wl-copy"]);
		expect(nativeCopyArgv("linux", { DISPLAY: ":0" })).toEqual([
			"xclip",
			"-selection",
			"clipboard",
		]);
		expect(nativeCopyArgv("linux", {})).toBeNull();
		expect(nativeCopyArgv("win32", {})).toBeNull();
	});

	test("copyText always writes OSC 52 and reports the native command", () => {
		const written: string[] = [];
		const ran: string[][] = [];
		const r = copyText("x", {
			write: (s) => written.push(s),
			env: {},
			platform: "darwin",
			runNative: (argv) => {
				ran.push(argv);
				return true;
			},
		});
		expect(written).toEqual([osc52("x")]);
		expect(ran).toEqual([["pbcopy"]]);
		expect(r).toEqual({ osc52: true, native: "pbcopy" });
	});

	test("copyReply says what happened", () => {
		const deps = { write: () => {}, env: { SSH_TTY: "/dev/ttys001" }, platform: "darwin" };
		expect(copyReply([], deps)).toBe("Nothing to copy yet: no answer in this chat.");
		expect(copyReply([{ role: "assistant", content: "a" }], deps)).toBe(
			"Sent the last answer to the clipboard (1 character).",
		);
		const local = { write: () => {}, env: {}, platform: "darwin", runNative: () => true };
		expect(copyReply([{ role: "assistant", content: "a" }], local)).toBe(
			"Copied the last answer (1 character).",
		);
	});

	test("over the OSC 52 cap: no sequence, the native copy still runs, and it says so", () => {
		const big = "x".repeat(80_000); // 106,668 bytes of base64
		expect(osc52Fits("x".repeat(75_000))).toBeTrue();
		expect(osc52Fits(big)).toBeFalse();
		const written: string[] = [];
		const ran: string[] = [];
		const msgs = [{ role: "assistant", content: big }];
		const local = {
			write: (s: string) => written.push(s),
			env: {},
			platform: "darwin",
			runNative: (_argv: string[], text: string) => {
				ran.push(text);
				return true;
			},
		};
		expect(copyReply(msgs, local)).toBe(
			"Copied the last answer (80000 characters) with pbcopy. It is too long for the terminal clipboard (over 100 KB encoded), so it was not sent to the terminal.",
		);
		expect(written).toEqual([]);
		expect(ran).toEqual([big]);
		const remote = {
			write: (s: string) => written.push(s),
			env: { SSH_TTY: "/dev/ttys001" },
			platform: "darwin",
		};
		expect(copyReply(msgs, remote)).toBe(
			"Nothing copied: the last answer (80000 characters) is too long for the terminal clipboard (over 100 KB encoded), and there is no local copy command here.",
		);
		expect(written).toEqual([]);
	});
});
