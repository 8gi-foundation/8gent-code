/**
 * The mouse layer's byte filter and its lifecycle (#3239). The filter is the
 * risky part: a byte it drops is a lost key, a byte it lets through is
 * typed into the chat. On main the per-chunk regex in useMouseScroll let the
 * tail of a split sequence through.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
	DISABLE_MOUSE,
	ENABLE_MOUSE,
	MouseFilter,
	_disposeMouse,
	injectKeys,
	installMouse,
	mouseEnabled,
	onMouse,
	parseSgr,
} from "./mouse-input";

const CLICK = "\x1b[<0;12;5M";
const RELEASE = "\x1b[<0;12;5m";

describe("parseSgr", () => {
	test("press, release, drag, move and wheel, 0-based cells", () => {
		expect(parseSgr(0, 12, 5, "M")).toMatchObject({ kind: "press", button: 0, x: 11, y: 4 });
		expect(parseSgr(0, 12, 5, "m")).toMatchObject({ kind: "release", x: 11, y: 4 });
		expect(parseSgr(32, 13, 5, "M")).toMatchObject({ kind: "drag", button: 0 });
		expect(parseSgr(35, 13, 5, "M")).toMatchObject({ kind: "move" });
		expect(parseSgr(64, 1, 1, "M")).toMatchObject({ kind: "wheel", button: 0 });
		expect(parseSgr(65, 1, 1, "M")).toMatchObject({ kind: "wheel", button: 1 });
		expect(parseSgr(4 + 16, 1, 1, "M")).toMatchObject({ shift: true, ctrl: true, alt: false });
	});
});

describe("MouseFilter", () => {
	test("a bracketed paste is the person's text, even when it looks like a click", () => {
		const f = new MouseFilter();
		const paste = `\x1b[200~hello ${CLICK} world\x1b[201~`;
		const r = f.feed(paste);
		expect(r.pass).toBe(paste);
		expect(r.events).toEqual([]);
		// And after the paste ends, clicks are clicks again.
		expect(f.feed(CLICK).events.length).toBe(1);
	});

	test("strips whole sequences and keeps every other byte", () => {
		const f = new MouseFilter();
		const r = f.feed(`ab${CLICK}cd${RELEASE}e`);
		expect(r.pass).toBe("abcde");
		expect(r.events.map((e) => e.kind)).toEqual(["press", "release"]);
		expect(f.pending).toBe("");
	});

	test("a sequence split at every offset never leaks a byte and still arrives", () => {
		const whole = `a${CLICK}b`;
		for (let cut = 1; cut < whole.length; cut++) {
			const f = new MouseFilter();
			const one = f.feed(whole.slice(0, cut));
			const two = f.feed(whole.slice(cut));
			expect({ cut, pass: one.pass + two.pass }).toEqual({ cut, pass: "ab" });
			expect(one.events.length + two.events.length).toBe(1);
			expect(f.pending).toBe("");
		}
	});

	test("typing, arrows, a paste and Esc keys pass untouched", () => {
		const f = new MouseFilter();
		for (const s of [
			"hello",
			"\x1b[A",
			"\x1b[Z",
			"\x1b[200~paste \x1b[<not mouse\x1b[201~",
			"\r",
			"é中",
		]) {
			const r = f.feed(s);
			expect(r.pass + f.flush()).toBe(s);
			expect(r.events).toEqual([]);
		}
	});

	test("a lone Esc is held only until flushed, then delivered as is", () => {
		const f = new MouseFilter();
		expect(f.feed("\x1b").pass).toBe("");
		expect(f.pending).toBe("\x1b");
		expect(f.flush()).toBe("\x1b");
		expect(f.pending).toBe("");
	});

	test("a held Esc followed by a key goes through with it", () => {
		const f = new MouseFilter();
		f.feed("\x1b");
		expect(f.feed("[A").pass).toBe("\x1b[A");
	});
});

describe("mouseEnabled", () => {
	test("on for a TTY by default, and under NO_COLOR (James's open call)", () => {
		expect(mouseEnabled({}, true, null)).toBe(true);
		expect(mouseEnabled({ NO_COLOR: "1" }, true, null)).toBe(true);
	});

	test("off for non-TTY, TERM=dumb, screen readers, EIGHT_MOUSE=0 and config mouse off", () => {
		expect(mouseEnabled({}, false, null)).toBe(false);
		expect(mouseEnabled({ TERM: "dumb" }, true, null)).toBe(false);
		expect(mouseEnabled({ INK_SCREEN_READER: "true" }, true, null)).toBe(false);
		expect(mouseEnabled({ EIGHT_MOUSE: "0" }, true, null)).toBe(false);
		expect(mouseEnabled({}, true, "off")).toBe(false);
	});
});

class FakeStdin extends EventEmitter {
	isTTY = true;
	readableFlowing: boolean | null = null;
	private queue: unknown[] = [];
	read(): unknown {
		return this.queue.shift() ?? null;
	}
	push(chunk: unknown) {
		this.queue.push(chunk);
	}
}

class FakeStdout {
	written = "";
	write = (s: string) => {
		this.written += s;
		return true;
	};
}

/** Drain what a paused-mode reader (Ink) would read after 'readable'. */
function drain(stdin: FakeStdin): string {
	let out = "";
	let c: unknown;
	while ((c = (stdin as unknown as { read: () => unknown }).read()) !== null) out += String(c);
	return out;
}

describe("installMouse", () => {
	test("a click's keys go out after the bytes read with it, in order (Codex review #1)", async () => {
		const stdin = new FakeStdin();
		installMouse(stdin as unknown as NodeJS.ReadStream, new FakeStdout(), {
			enabled: true,
			processHooks: false,
		});
		onMouse((e) => {
			if (e.kind === "release") injectKeys("X");
		});
		stdin.push(`a${CLICK}${RELEASE}b`);
		// Ink's loop reads until null: the chunk's bytes first, the click's key after.
		expect(drain(stdin)).toBe("abX");
	});

	test("the rest of a held sequence that arrives at the hold deadline is still a click (#4)", async () => {
		const stdin = new FakeStdin();
		installMouse(stdin as unknown as NodeJS.ReadStream, new FakeStdout(), {
			enabled: true,
			processHooks: false,
		});
		const seen: string[] = [];
		onMouse((e) => seen.push(e.kind));
		stdin.push("\x1b[<0;12;");
		expect(drain(stdin)).toBe("");
		await new Promise((r) => setTimeout(r, 40));
		stdin.push("5M");
		expect(drain(stdin)).toBe("");
		expect(seen).toEqual(["press"]);
	});

	test("a chunk of only mouse bytes does not end the read while more is buffered", () => {
		const stdin = new FakeStdin();
		installMouse(stdin as unknown as NodeJS.ReadStream, new FakeStdout(), {
			enabled: true,
			processHooks: false,
		});
		stdin.push(CLICK);
		stdin.push("k");
		expect(drain(stdin)).toBe("k");
	});

	test("a UTF-8 character split across Buffer reads arrives whole (#3)", () => {
		const stdin = new FakeStdin();
		installMouse(stdin as unknown as NodeJS.ReadStream, new FakeStdout(), {
			enabled: true,
			processHooks: false,
		});
		(stdin as unknown as { push: (c: unknown) => void }).push(Buffer.from([0xc3]));
		(stdin as unknown as { push: (c: unknown) => void }).push(Buffer.from([0xa9]));
		expect(drain(stdin)).toBe("é");
	});

	afterEach(() => _disposeMouse());

	test("turns reporting on, filters what Ink reads, and turns it off twice on dispose", () => {
		const stdin = new FakeStdin();
		const stdout = new FakeStdout();
		const inst = installMouse(stdin as unknown as NodeJS.ReadStream, stdout, {
			enabled: true,
			processHooks: false,
		});
		expect(stdout.written).toBe(ENABLE_MOUSE);
		const seen: string[] = [];
		onMouse((e) => seen.push(e.kind));
		stdin.push(`x${CLICK}`);
		stdin.push(`${RELEASE}y`);
		expect(drain(stdin)).toBe("xy");
		expect(seen).toEqual(["press", "release"]);
		inst?.dispose();
		expect(stdout.written.endsWith(DISABLE_MOUSE + DISABLE_MOUSE)).toBe(true);
	});

	test("a partial at the end of a read is delivered after the hold, so Esc still works", async () => {
		const stdin = new FakeStdin();
		installMouse(stdin as unknown as NodeJS.ReadStream, new FakeStdout(), {
			enabled: true,
			processHooks: false,
		});
		let woke = 0;
		stdin.on("readable", () => woke++);
		stdin.push("\x1b");
		expect(drain(stdin)).toBe("");
		await new Promise((r) => setTimeout(r, 60));
		expect(woke).toBe(1);
		expect(drain(stdin)).toBe("\x1b");
	});

	test("injected keys reach the reader as typed bytes", async () => {
		const stdin = new FakeStdin();
		installMouse(stdin as unknown as NodeJS.ReadStream, new FakeStdout(), {
			enabled: true,
			processHooks: false,
		});
		let woke = 0;
		stdin.on("readable", () => woke++);
		injectKeys("\x10");
		// Never synchronously: a click is dispatched from inside Ink's read loop.
		expect(woke).toBe(0);
		await new Promise((r) => setImmediate(r));
		expect(woke).toBe(1);
		expect(drain(stdin)).toBe("\x10");
	});

	test("not enabled: nothing is patched or written", () => {
		const stdin = new FakeStdin();
		const stdout = new FakeStdout();
		expect(
			installMouse(stdin as unknown as NodeJS.ReadStream, stdout, { enabled: false }),
		).toBeNull();
		expect(stdout.written).toBe("");
		stdin.push(CLICK);
		expect(drain(stdin)).toBe(CLICK);
	});
});
