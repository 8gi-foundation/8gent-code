/**
 * The living 8 in the header (#3160): the frames, the one-write overlay, the
 * guards, and the writer against a fake terminal stream.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { INTRO_PALETTE } from "./intro-converge.js";
import {
	BEAT_MS,
	BSU,
	ESU,
	LivingMarkWriter,
	MARK_ORIGIN,
	type MarkStream,
	type Paint,
	RESIZE_SETTLE_MS,
	frameKey,
	headerMarkFrame,
	overlaySequence,
	stillReason,
} from "./living-mark.js";
import { MARK_HEADER } from "./mark8-cells.js";

const PAINT: Paint = {
	top: ["<T>", "</>"],
	bottom: ["<B>", "</>"],
	lift: ["<L>", "</>"],
};
const TTY_ENV = { TERM: "xterm-256color" };
/** A regex over terminal escapes, written with a named ESC instead of a control character. */
const esc = (src: string, flags = "g") => new RegExp(src.replaceAll("ESC", "\\u001b"), flags);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeTty extends EventEmitter implements MarkStream {
	isTTY = true;
	columns = 160;
	rows = 48;
	chunks: string[] = [];
	write = (chunk: unknown): boolean => {
		this.chunks.push(String(chunk));
		return true;
	};
	marks(): string[] {
		return this.chunks.filter((c) => c.includes("\x1b7"));
	}
}

function writer(stream: FakeTty, env: Record<string, string | undefined> = TTY_ENV) {
	return new LivingMarkWriter(stream, { env, platform: "darwin", paint: () => PAINT });
}

describe("headerMarkFrame", () => {
	test("still is exactly the header mark, amber on top and orange below", () => {
		const f = headerMarkFrame(0, false);
		expect(f.map((row) => row.map((c) => c.ch).join(""))).toEqual([...MARK_HEADER]);
		expect(f[0].every((c) => c.colour === "top")).toBe(true);
		expect(f[2].every((c) => c.colour === "bottom")).toBe(true);
	});

	test("the same moment always gives the same frame, and a frame holds for its whole beat", () => {
		for (const t of [0, 5000, 123_456]) {
			expect(frameKey(headerMarkFrame(t, true))).toBe(frameKey(headerMarkFrame(t, true)));
			const beat = Math.floor(t / BEAT_MS) * BEAT_MS;
			expect(frameKey(headerMarkFrame(beat, true))).toBe(
				frameKey(headerMarkFrame(beat + BEAT_MS - 1, true)),
			);
		}
	});

	test("alive: a wave moves and dots blink, never more than 8 changes a second", () => {
		let changes = 0;
		let prev = "";
		let lit = 0;
		let dark = 0;
		const total = [...MARK_HEADER.join("")].reduce((n, ch) => {
			const v = (ch.codePointAt(0) ?? 0x2800) - 0x2800;
			let bits = 0;
			for (let b = v; b; b >>= 1) bits += b & 1;
			return n + bits;
		}, 0);
		const seconds = 120;
		for (let t = 0; t < seconds * 1000; t += 10) {
			const f = headerMarkFrame(t, true);
			const key = frameKey(f);
			if (key !== prev) changes++;
			prev = key;
			if (t % BEAT_MS === 0) {
				let on = 0;
				for (const row of f)
					for (const c of row) {
						const v = (c.ch.codePointAt(0) ?? 0x2800) - 0x2800;
						for (let b = v; b > 0; b >>= 1) on += b & 1;
					}
				lit += on;
				dark += total - on;
			}
		}
		expect(changes / seconds).toBeLessThanOrEqual(1000 / BEAT_MS);
		expect(changes).toBeGreaterThan(seconds);
		// About one dot in seventy is dark on any beat.
		const share = dark / (lit + dark);
		expect(share).toBeGreaterThan(1 / 200);
		expect(share).toBeLessThan(1 / 30);
	});

	test("alive colours stay amber to orange: no purple, no pink (hues 270 to 350 banned)", () => {
		const hue = (hex: string) => {
			const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
			const max = Math.max(r, g, b);
			const d = max - Math.min(r, g, b);
			if (d === 0) return 0;
			const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
			return (h * 60 + 360) % 360;
		};
		const seen = new Set<string>();
		for (let t = 0; t < 10_000; t += BEAT_MS)
			for (const row of headerMarkFrame(t, true))
				for (const c of row) if (c.colour) seen.add(c.colour);
		expect([...seen].sort()).toEqual(["bottom", "lift", "top"]);
		for (const k of seen) {
			const h = hue(INTRO_PALETTE[k as keyof typeof INTRO_PALETTE]);
			expect(h).toBeGreaterThanOrEqual(15);
			expect(h).toBeLessThanOrEqual(45);
		}
	});
});

describe("overlaySequence", () => {
	test("saves the cursor, writes only the mark's cells at the header origin, restores the cursor", () => {
		const s = overlaySequence(headerMarkFrame(0, false), PAINT);
		expect(s.startsWith("\x1b7")).toBe(true);
		expect(s.endsWith("\x1b8")).toBe(true);
		expect(s).not.toContain("\n");
		expect(s).not.toContain("\r");
		const moves = [...s.matchAll(esc("ESC\\[(\\d+);(\\d+)H"))].map((m) => [
			Number(m[1]),
			Number(m[2]),
		]);
		expect(moves).toEqual([
			[MARK_ORIGIN.row, MARK_ORIGIN.col],
			[MARK_ORIGIN.row + 1, MARK_ORIGIN.col],
			[MARK_ORIGIN.row + 2, MARK_ORIGIN.col],
		]);
		// No other cursor movement, erase or scroll escape.
		const other = s.replace(esc("ESC\\[\\d+;\\d+H"), "").match(esc("ESC\\[[\\d;?]*[A-GJKSTfsu]"));
		expect(other).toBeNull();
		// Exactly the mark's glyphs, row by row.
		const text = s.replace(esc("ESC[78]"), "").replace(/<.>|<\/>/g, "");
		expect(text.split(esc("ESC\\[\\d+;\\d+H", "")).slice(1)).toEqual([...MARK_HEADER]);
	});
});

describe("stillReason", () => {
	const screen = { isTTY: true, columns: 160, rows: 48 };
	test("a plain colour terminal may live", () => {
		expect(stillReason(TTY_ENV, screen, "darwin")).toBeNull();
	});
	test.each([
		[{ ...TTY_ENV, NO_COLOR: "1" }, screen, "NO_COLOR"],
		[{ TERM: "dumb" }, screen, "TERM=dumb"],
		[{ ...TTY_ENV, "8GENT_REDUCED_MOTION": "1" }, screen, "reduced motion"],
		[{ ...TTY_ENV, EIGHT_ASCII: "1" }, screen, "no braille"],
		[{ TERM: "linux" }, screen, "no braille"],
		[{ ...TTY_ENV, INK_SCREEN_READER: "true" }, screen, "screen reader"],
		[{ ...TTY_ENV, CI: "true" }, screen, "CI"],
		[TTY_ENV, { ...screen, columns: 59 }, "terminal too small"],
		[TTY_ENV, { ...screen, rows: 11 }, "terminal too small"],
		[TTY_ENV, { ...screen, isTTY: false }, "not a terminal"],
	] as const)("%p on %p is still: %s", (env, scr, reason) => {
		expect(stillReason(env, scr, "darwin")).toBe(reason);
	});
});

describe("LivingMarkWriter", () => {
	test("active on a colour terminal: the mark changes at most once a beat, one write each", async () => {
		const tty = new FakeTty();
		const w = writer(tty);
		w.setActive(true);
		await wait(BEAT_MS * 6);
		w.dispose();
		const marks = tty.marks();
		expect(marks.length).toBeGreaterThanOrEqual(3);
		expect(marks.length).toBeLessThanOrEqual(7);
		for (const m of marks) {
			expect(m.startsWith(`${BSU}\x1b7`)).toBe(true);
			expect(m.endsWith(`\x1b8${ESU}`)).toBe(true);
		}
	});

	test.each([
		["NO_COLOR", { ...TTY_ENV, NO_COLOR: "1" }],
		["TERM=dumb", { TERM: "dumb" }],
		["reduced motion", { ...TTY_ENV, "8GENT_REDUCED_MOTION": "1" }],
		["no braille", { ...TTY_ENV, EIGHT_ASCII: "1" }],
	])("%s: nothing is written at all", async (_name, env) => {
		const tty = new FakeTty();
		const w = writer(tty, env);
		w.setActive(true);
		await wait(BEAT_MS * 3);
		w.dispose();
		expect(tty.chunks).toEqual([]);
	});

	test("no colour Ink would draw with (or under 256): still, nothing written", async () => {
		const tty = new FakeTty();
		const w = new LivingMarkWriter(tty, { env: TTY_ENV, platform: "darwin", paint: () => null });
		w.setActive(true);
		await wait(BEAT_MS * 3);
		expect(w.isRunning).toBe(false);
		w.dispose();
		expect(tty.chunks).toEqual([]);
	});

	test("a hold (overlay, approval, scroll) stops it and the mark comes to rest still", async () => {
		const tty = new FakeTty();
		const w = writer(tty);
		w.setActive(true);
		await wait(BEAT_MS * 3);
		w.hold("overlay", true);
		expect(w.isRunning).toBe(false);
		const rest = tty.chunks.at(-1) ?? "";
		expect(rest).toBe(overlaySequence(headerMarkFrame(0, false), PAINT));
		const n = tty.chunks.length;
		await wait(BEAT_MS * 3);
		expect(tty.chunks.length).toBe(n);
		// A second hold keeps it still after the first lets go.
		w.hold("scroll", true);
		w.hold("overlay", false);
		expect(w.isRunning).toBe(false);
		w.hold("scroll", false);
		expect(w.isRunning).toBe(true);
		w.dispose();
	});

	test("Ink's frame gets the living cells inside its own synchronized block", async () => {
		const tty = new FakeTty();
		const w = writer(tty);
		w.setActive(true);
		await wait(BEAT_MS * 2);
		tty.chunks.length = 0;
		// What Ink writes for one frame: begin, the frame, end, in one tick.
		tty.write(BSU);
		tty.write("\x1b[2K\x1b[1A\x1b[2K\x1b[Gframe");
		tty.write(ESU);
		await wait(0);
		expect(tty.chunks[0]).toBe(BSU);
		expect(tty.chunks[1]).toBe("\x1b[2K\x1b[1A\x1b[2K\x1b[Gframe");
		expect(tty.chunks[2].startsWith("\x1b7")).toBe(true);
		expect(tty.chunks[2].endsWith(`\x1b8${ESU}`)).toBe(true);
		// No second repaint after the frame: it already went out inside it.
		expect(tty.chunks.length).toBe(3);
		w.dispose();
	});

	test("any other write gets the mark back on the next microtask, once", async () => {
		const tty = new FakeTty();
		const w = writer(tty);
		w.setActive(true);
		await wait(BEAT_MS * 2);
		tty.chunks.length = 0;
		tty.write("a console line\n");
		tty.write("another");
		expect(tty.chunks.length).toBe(2);
		await Promise.resolve();
		expect(tty.chunks.length).toBe(3);
		expect(tty.chunks[2].includes("\x1b7")).toBe(true);
		w.dispose();
	});

	test("a resize stops it until the size has held, then it comes back", async () => {
		const tty = new FakeTty();
		const w = writer(tty);
		w.setActive(true);
		await wait(BEAT_MS * 2);
		tty.columns = 120;
		tty.emit("resize");
		expect(w.isRunning).toBe(false);
		const n = tty.chunks.length;
		await wait(RESIZE_SETTLE_MS / 2);
		tty.emit("resize");
		await wait(RESIZE_SETTLE_MS / 2 + 20);
		// No write while the size is moving: the place is not known yet.
		expect(tty.chunks.length).toBe(n);
		expect(w.isRunning).toBe(false);
		await wait(RESIZE_SETTLE_MS / 2 + BEAT_MS * 2);
		expect(w.isRunning).toBe(true);
		// Resized too small: still.
		tty.columns = 50;
		tty.emit("resize");
		await wait(RESIZE_SETTLE_MS + BEAT_MS);
		expect(w.isRunning).toBe(false);
		w.dispose();
	});

	test("dispose puts the stream's own write back and writes nothing more", async () => {
		const tty = new FakeTty();
		const own = tty.write;
		const w = writer(tty);
		w.setActive(true);
		await wait(BEAT_MS);
		expect(tty.write).not.toBe(own);
		w.dispose();
		expect(tty.write).toBe(own);
		const n = tty.chunks.length;
		await wait(BEAT_MS * 2);
		expect(tty.chunks.length).toBe(n);
	});

	test("leaving (unmount, exit) stops it without writing the still mark", async () => {
		const tty = new FakeTty();
		const w = writer(tty);
		w.setActive(true);
		await wait(BEAT_MS * 2);
		const n = tty.chunks.length;
		w.setActive(false, false);
		expect(w.isRunning).toBe(false);
		expect(tty.chunks.length).toBe(n);
		w.dispose();
	});

	test("a resize stops it before Ink's own resize handler redraws", async () => {
		const tty = new FakeTty();
		let runningWhenInkRedraws = null as boolean | null;
		const w = writer(tty);
		// Ink subscribes first, at mount.
		tty.on("resize", () => {
			runningWhenInkRedraws = w.isRunning;
			tty.write(BSU);
			tty.write("frame at the new size");
			tty.write(ESU);
		});
		w.setActive(true);
		await wait(BEAT_MS * 2);
		tty.chunks.length = 0;
		tty.emit("resize");
		await wait(0);
		expect(runningWhenInkRedraws).toBe(false);
		expect(tty.chunks).toEqual([BSU, "frame at the new size", ESU]);
		w.dispose();
	});
});
