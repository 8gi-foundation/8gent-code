/**
 * The living 8 in the HUD header (#3160).
 *
 * The header carries the 4 x 3 braille mark (MARK_HEADER) to the left of the
 * brand pill. Ink draws it still. While the HUD is idle and nothing sits over
 * it, this module keeps it alive in the same language as the intro (#3159): a
 * slow wave down the stroke and about one dot in seventy blinking off for a
 * beat, changing at most 8 times a second.
 *
 * Why it lives outside Ink: every Ink render lays out and rewrites the whole
 * screen (about 27 ms of CPU each, #3100). A mark ticking through React state
 * would cost 11 to 22% idle CPU. Instead a writer saves the cursor (ESC 7),
 * writes only the mark's cells at their known place, and restores the cursor
 * (ESC 8), all in one write. No React state, no Ink render.
 *
 * Not fighting Ink:
 * - One write per beat, so it never lands inside an Ink frame; the cursor
 *   and the pen are restored, so Ink's relative moves stay correct.
 * - When Ink draws a frame it paints the still mark. The writer sees Ink's
 *   end-of-frame marker (ESC[?2026l, synchronized output) go past and puts
 *   its cells in front of it, inside Ink's own synchronized block, so the
 *   terminal never shows the still mark over the living one. Any other
 *   write gets the cells back on the next microtask.
 * - A resize stops it until the size has held for RESIZE_SETTLE_MS and Ink
 *   has redrawn; the place is re-checked before the next beat.
 *
 * Still (never animates) under NO_COLOR, TERM=dumb, reduced motion, no
 * braille, fewer than 256 colours, a screen reader, CI or a non-TTY, a
 * terminal too small for the header, and while anything holds it (an
 * overlay, an approval card, a scrolled chat).
 */

import { Text, renderToString } from "ink";
import React from "react";
import { type ColourKey, INTRO_PALETTE, dotsOf, twinkleOff, waveAt } from "./intro-converge.js";
import { MARK_HEADER } from "./mark8-cells.js";
import { reducedMotionFromEnv } from "./motion.js";
import { drawsColour, unicodeRich } from "./term-caps.js";

type Env = Record<string, string | undefined>;

/** One beat of the living mark: the same 125 ms as the intro. At most 8 changes a second. */
export const BEAT_MS = 125;
/** A resize must hold this long before the mark comes back. */
export const RESIZE_SETTLE_MS = 400;
/** The mark's top-left cell, 1-based: the first column of the header's first row. */
export const MARK_ORIGIN = { row: 1, col: 1 } as const;
/** Columns the mark takes in the header: 4 cells and a one-column gap. */
export const MARK_COLUMNS = 5;
/** Below this many rows the HUD is not the full shell; the mark stays still. */
export const MIN_ROWS = 12;
/** Below this many columns the mark stays still (the header drops it sooner). */
export const MIN_COLS = 60;

/** Synchronized output: Ink writes each marker on its own. */
export const BSU = "\x1b[?2026h";
export const ESU = "\x1b[?2026l";
const SAVE = "\x1b7";
const RESTORE = "\x1b8";

export interface MarkCell {
	ch: string;
	colour: ColourKey | null;
}

const DOTS = dotsOf(MARK_HEADER);
const MARK_ROWS = MARK_HEADER.length;
const MARK_COLS = Math.max(...MARK_HEADER.map((r) => [...r].length));
const MARK_H = MARK_ROWS * 4;

const BIT: Record<string, number> = {
	"0,0": 0x01,
	"0,1": 0x02,
	"0,2": 0x04,
	"1,0": 0x08,
	"1,1": 0x10,
	"1,2": 0x20,
	"0,3": 0x40,
	"1,3": 0x80,
};
const RANK: Partial<Record<ColourKey, number>> = { bottom: 1, top: 2, lift: 3 };

/**
 * The header mark at `t` ms, one row of cells per mark row. Still when
 * `alive` is false: amber top half, orange bottom half, every dot lit, which
 * is what Ink draws. Alive: the intro's wave lifts the crest toward pale
 * amber and about one dot in seventy is dark for the beat. Deterministic.
 */
export function headerMarkFrame(t: number, alive: boolean): MarkCell[][] {
	const bits: number[][] = Array.from({ length: MARK_ROWS }, () => Array(MARK_COLS).fill(0));
	const colour: (ColourKey | null)[][] = Array.from({ length: MARK_ROWS }, () =>
		Array(MARK_COLS).fill(null),
	);
	DOTS.forEach((d, i) => {
		let c: ColourKey = d.y < MARK_H / 2 ? "top" : "bottom";
		if (alive) {
			if (twinkleOff(i, t)) return;
			if (waveAt(d.y, MARK_H, t) > 0.8) c = "lift";
		}
		const r = Math.floor(d.y / 4);
		const k = Math.floor(d.x / 2);
		bits[r][k] |= BIT[`${d.x % 2},${d.y % 4}`] ?? 0;
		const prev = colour[r][k];
		if (!prev || (RANK[c] ?? 0) > (RANK[prev] ?? 0)) colour[r][k] = c;
	});
	return bits.map((row, r) =>
		row.map((v, k) =>
			v
				? { ch: String.fromCodePoint(0x2800 + v), colour: colour[r][k] }
				: { ch: " ", colour: null },
		),
	);
}

/** A frame as one comparable string. */
export function frameKey(frame: MarkCell[][]): string {
	return frame.map((row) => row.map((c) => `${c.ch}${c.colour ?? "-"}`).join("")).join("|");
}

/** Open and close escapes for each colour, exactly as Ink writes them. */
export type Paint = Partial<Record<ColourKey, readonly [open: string, close: string]>>;

/**
 * The escapes Ink itself uses for the mark's colours, read by rendering one
 * cell through Ink (so chalk's colour level is the same one Ink draws with).
 * Null when the terminal gets no colour or fewer than 256 colours: too coarse
 * for a subtle wave, so the mark stays still there.
 */
export function inkPaint(): Paint | null {
	const out: Paint = {};
	for (const key of ["top", "bottom", "lift"] as const) {
		const s = renderToString(React.createElement(Text, { color: INTRO_PALETTE[key] }, "⠀"));
		const at = s.indexOf("⠀");
		if (at <= 0) return null;
		const open = s.slice(0, at);
		if (!open.includes("38;2;") && !open.includes("38;5;")) return null;
		out[key] = [open, s.slice(at + 1)];
	}
	return out;
}

/**
 * One write that paints the mark at `origin` (1-based) and puts the cursor
 * and the pen back where they were.
 */
export function overlaySequence(
	frame: MarkCell[][],
	paint: Paint,
	origin: { row: number; col: number } = MARK_ORIGIN,
): string {
	let s = SAVE;
	frame.forEach((row, r) => {
		s += `\x1b[${origin.row + r};${origin.col}H`;
		for (const cell of row) {
			const p = cell.colour ? paint[cell.colour] : undefined;
			s += p ? p[0] + cell.ch + p[1] : cell.ch;
		}
	});
	return s + RESTORE;
}

/** Whether a CI environment is set, the same test Ink uses (is-in-ci). */
function inCi(env: Env): boolean {
	if (env.CI === "0" || env.CI === "false") return false;
	return (
		"CI" in env ||
		"CONTINUOUS_INTEGRATION" in env ||
		Object.keys(env).some((k) => k.startsWith("CI_"))
	);
}

export interface Screen {
	isTTY?: boolean;
	columns?: number;
	rows?: number;
}

/**
 * Why the mark must stay still on this terminal, or null when it may live.
 * Checked on every start and after every resize.
 */
export function stillReason(
	env: Env,
	screen: Screen,
	platform: string = process.platform,
): string | null {
	if (!screen.isTTY) return "not a terminal";
	if (inCi(env)) return "CI";
	if (env.TERM === "dumb") return "TERM=dumb";
	if (!drawsColour(env)) return "NO_COLOR";
	if (reducedMotionFromEnv(env)) return "reduced motion";
	if (!unicodeRich(env, platform)) return "no braille";
	if (env.INK_SCREEN_READER === "true") return "screen reader";
	if ((screen.columns ?? 0) < MIN_COLS || (screen.rows ?? 0) < MIN_ROWS)
		return "terminal too small";
	return null;
}

// ------------------------------------------------------------------ writer

type WriteFn = (chunk: unknown, ...rest: unknown[]) => boolean;

export interface MarkStream extends Screen {
	write: WriteFn;
	on?(event: "resize", fn: () => void): unknown;
	prependListener?(event: "resize", fn: () => void): unknown;
	off?(event: "resize", fn: () => void): unknown;
}

export interface WriterDeps {
	env?: Env;
	platform?: string;
	now?: () => number;
	/** Colour escapes; defaults to inkPaint(), read once on first start. */
	paint?: () => Paint | null;
}

/**
 * Drives the living mark on one stream. `setActive` says the HUD wants it
 * (the main view is up and motion is on); `hold` lets any surface over the
 * HUD keep it still. It runs only while active, unheld, settled after any
 * resize, and allowed by `stillReason`.
 */
export class LivingMarkWriter {
	private active = false;
	private readonly holds = new Set<string>();
	private resizing = false;
	private disposed = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private settleTimer: ReturnType<typeof setTimeout> | null = null;
	private running = false;
	private frame: MarkCell[][] | null = null;
	private lastKey = "";
	private paintCache: Paint | null | undefined;
	/** The stream's own write, captured when the watch is installed. */
	private originalWrite: WriteFn;
	private wrapped: WriteFn | null = null;
	private own = false;
	private dirty = false;
	private repaintQueued = false;
	/** Beats that changed the mark, for tests and the idle probe. */
	writes = 0;

	constructor(
		private readonly stream: MarkStream,
		private readonly deps: WriterDeps = {},
	) {
		this.originalWrite = stream.write;
	}

	get isRunning(): boolean {
		return this.running;
	}

	/** The HUD asked for the living mark (running also needs the guards). */
	get isActive(): boolean {
		return this.active;
	}

	/**
	 * `rest` paints the still mark when this stops it. Pass false when the
	 * header is going away (unmount, exit): nothing is written then.
	 */
	setActive(on: boolean, rest = true): void {
		this.active = on;
		this.update(rest);
	}

	hold(key: string, on: boolean): void {
		if (on) this.holds.add(key);
		else this.holds.delete(key);
		this.update(true);
	}

	dispose(): void {
		this.disposed = true;
		this.update(false);
		if (this.settleTimer) clearTimeout(this.settleTimer);
		this.stream.off?.("resize", this.onResize);
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	private paint(): Paint | null {
		if (this.paintCache === undefined) this.paintCache = (this.deps.paint ?? inkPaint)();
		return this.paintCache;
	}

	private allowed(): boolean {
		return (
			!this.disposed &&
			this.active &&
			this.holds.size === 0 &&
			!this.resizing &&
			stillReason(this.deps.env ?? process.env, this.stream, this.deps.platform) === null
		);
	}

	/** Start or stop to match the guards. `rest` paints the still mark on a stop. */
	private update(rest: boolean): void {
		const want = this.allowed();
		if (want && !this.running) this.start();
		else if (!want && this.running) this.stop(rest && !this.resizing && !this.disposed);
	}

	/**
	 * Starts on the next beat boundary, never inside the caller: a start comes
	 * from a React effect, and reading Ink's colours renders through Ink.
	 */
	private start(): void {
		this.running = true;
		this.lastKey = "";
		this.listen();
		this.installWrap();
		this.schedule();
	}

	private schedule(): void {
		this.timer = setTimeout(this.beat, BEAT_MS - (this.now() % BEAT_MS));
		(this.timer as { unref?: () => void }).unref?.();
	}

	private stop(rest: boolean): void {
		this.running = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.removeWrap();
		const paint = this.paintCache;
		if (rest && paint && this.lastKey)
			this.rawWrite(overlaySequence(headerMarkFrame(0, false), paint));
		this.frame = null;
		this.lastKey = "";
	}

	private beat = (): void => {
		this.timer = null;
		if (!this.running) return;
		if (!this.paint()) {
			// No colour Ink would draw with, or fewer than 256: stay still.
			this.stop(false);
			return;
		}
		const t = this.now();
		const frame = headerMarkFrame(t, true);
		const key = frameKey(frame);
		this.frame = frame;
		if (key !== this.lastKey) {
			this.lastKey = key;
			this.writes++;
			this.rawWrite(this.overlay());
		}
		this.schedule();
	};

	private overlay(): string {
		const paint = this.paintCache;
		if (!paint || !this.frame) return "";
		return BSU + overlaySequence(this.frame, paint) + ESU;
	}

	private rawWrite(s: string): void {
		if (!s) return;
		this.own = true;
		try {
			(this.wrapped ? this.originalWrite : this.stream.write).call(this.stream, s);
		} finally {
			this.own = false;
		}
		this.dirty = false;
	}

	/**
	 * Watch the stream's writes while running. Ink's end-of-frame marker gets
	 * the mark in front of it, inside Ink's synchronized block. Anything else
	 * (a frame without synchronized output, a console line) gets it back on
	 * the next microtask, after the rest of that synchronous write.
	 */
	private installWrap(): void {
		if (this.wrapped) return;
		this.originalWrite = this.stream.write;
		const self = this;
		const wrapped: WriteFn = function (this: unknown, chunk: unknown, ...rest: unknown[]) {
			if (self.own || !self.running) return self.originalWrite.call(self.stream, chunk, ...rest);
			if (chunk === ESU && self.frame && self.paintCache) {
				self.dirty = false;
				const cells = overlaySequence(self.frame, self.paintCache);
				return self.originalWrite.call(self.stream, cells + chunk, ...rest);
			}
			const r = self.originalWrite.call(self.stream, chunk, ...rest);
			self.dirty = true;
			if (!self.repaintQueued) {
				self.repaintQueued = true;
				queueMicrotask(() => {
					self.repaintQueued = false;
					if (self.dirty && self.running && self.frame) self.rawWrite(self.overlay());
				});
			}
			return r;
		};
		this.wrapped = wrapped;
		this.stream.write = wrapped;
	}

	private removeWrap(): void {
		if (!this.wrapped) return;
		// Only unwind our own wrapper; if something wrapped over it, it stays
		// and passes straight through (running is false).
		if (this.stream.write === this.wrapped) {
			this.stream.write = this.originalWrite;
			this.wrapped = null;
		}
	}

	private listening = false;
	private listen(): void {
		if (this.listening) return;
		this.listening = true;
		// Ahead of Ink's own resize listener, so the mark stops before Ink
		// redraws at the new size, not after.
		if (this.stream.prependListener) this.stream.prependListener("resize", this.onResize);
		else this.stream.on?.("resize", this.onResize);
	}

	private onResize = (): void => {
		this.resizing = true;
		this.update(false);
		if (this.settleTimer) clearTimeout(this.settleTimer);
		this.settleTimer = setTimeout(() => {
			this.settleTimer = null;
			this.resizing = false;
			this.update(false);
		}, RESIZE_SETTLE_MS);
		(this.settleTimer as { unref?: () => void }).unref?.();
	};
}

const WRITERS = new WeakMap<object, LivingMarkWriter>();

/** The one writer for a stream (process.stdout in the app). */
export function livingMarkWriter(stream: MarkStream): LivingMarkWriter {
	let w = WRITERS.get(stream);
	if (!w) {
		w = new LivingMarkWriter(stream);
		WRITERS.set(stream, w);
	}
	return w;
}

/**
 * Keep the mark still while `on` (an overlay, a scrolled chat). Keys are
 * independent: the mark lives again only when every hold is released.
 */
export function holdLivingMark(
	key: string,
	on: boolean,
	stream: MarkStream = process.stdout as unknown as MarkStream,
): void {
	livingMarkWriter(stream).hold(key, on);
}
