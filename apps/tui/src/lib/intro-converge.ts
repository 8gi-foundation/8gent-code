/**
 * The launch splash, direction B "Converge" (#3159, James's pick): the dots of
 * the braille figure-8 start on a ring near the edge of the screen, warp
 * inward and settle into the mark, give one warm pulse, and then stay alive: a
 * slow colour wave travels down the stroke and a few dots blink off for a
 * beat, so the pixels read as alive without a loop that pulls the eye.
 *
 * Pure: no React, no Ink, no clock. Everything is a function of the elapsed
 * time, so every frame can be tested, and a frame is the same on every run
 * (the ring and the twinkle come from a fixed hash, not Math.random).
 *
 * Output is one row of runs per terminal row: text plus a colour key. A cell
 * has one colour (a terminal constraint), so each braille cell takes the
 * colour of its strongest dot. `colour` is a key into INTRO_PALETTE, or null
 * for the background; the component maps keys to hex, or to nothing under
 * NO_COLOR.
 */

import { MARK_INTRO } from "./mark8-cells.js";

// ------------------------------------------------------------------ timing

/** Dots start moving between 0 and this, so the ring does not move as one. */
export const STAGGER_MAX_MS = 180;
/** Each dot's flight, eased out. */
export const FLIGHT_MS = 700;
/** Every dot has landed by now. */
export const LANDED_MS = STAGGER_MAX_MS + FLIGHT_MS;
/** One warm pulse as the mark completes. */
export const PULSE_MS = 140;
/** The name and the line come up after the mark lands, in three tone steps. */
export const TEXT_AT_MS = 900;
export const TEXT_FADE_MS = 210;
/** Hand off to the HUD. Same budget as the splash it replaces (1.49 s). */
export const INTRO_DONE_MS = 1490;
/** The living mark changes at most this often: 8 fps. */
export const ALIVE_FRAME_MS = 125;
/** One sweep of the colour wave down the stroke. */
export const ALIVE_WAVE_MS = 2400;

export const INTRO_NAME = "8gent Code";
export const INTRO_LINE = "Free, local, open. Yours.";

// ------------------------------------------------------------------ geometry

export type IntroSize = keyof typeof MARK_INTRO;

export interface Dot {
	/** Dot position inside the mark, in dots (2 per cell across, 4 down). */
	x: number;
	y: number;
}

const BITS: readonly (readonly [number, number, number])[] = [
	[0, 0, 0x01],
	[0, 1, 0x02],
	[0, 2, 0x04],
	[1, 0, 0x08],
	[1, 1, 0x10],
	[1, 2, 0x20],
	[0, 3, 0x40],
	[1, 3, 0x80],
];

/** Every lit dot of a braille mark, in reading order. */
export function dotsOf(rows: readonly string[]): Dot[] {
	const out: Dot[] = [];
	rows.forEach((line, r) => {
		[...line].forEach((ch, c) => {
			const v = (ch.codePointAt(0) ?? 0) - 0x2800;
			if (v <= 0 || v > 0xff) return;
			for (const [dx, dy, bit] of BITS) if (v & bit) out.push({ x: c * 2 + dx, y: r * 4 + dy });
		});
	});
	return out;
}

/** Rows the splash needs below the mark: gap, name, gap, line. */
const BELOW_MARK = 4;

/** The largest mark that leaves the name and line room, or null when nothing fits. */
export function introSize(cols: number, rows: number): IntroSize | null {
	const fits = (s: IntroSize) => {
		const m = MARK_INTRO[s];
		return (
			m.length + BELOW_MARK + 2 <= rows &&
			(m[0]?.length ?? 0) + 2 <= cols &&
			INTRO_LINE.length + 2 <= cols
		);
	};
	if (rows >= 40 && fits("large")) return "large";
	if (rows >= 28 && fits("medium")) return "medium";
	if (fits("small")) return "small";
	return null;
}

export interface IntroLayout {
	size: IntroSize;
	/** Top-left cell of the mark. */
	top: number;
	left: number;
	markCols: number;
	markRows: number;
	/** The shared centre column: the mark, the name and the line all sit on it. */
	axis: number;
	nameRow: number;
	nameLeft: number;
	lineRow: number;
	lineLeft: number;
	/** The quiet hint on the last-but-one row. */
	hintRow: number;
}

export function introLayout(cols: number, rows: number, size: IntroSize): IntroLayout {
	const m = MARK_INTRO[size];
	const markRows = m.length;
	const markCols = m[0]?.length ?? 0;
	const height = markRows + BELOW_MARK;
	const top = Math.max(0, Math.floor((rows - height) / 2));
	const left = Math.max(0, Math.floor((cols - markCols) / 2));
	// One axis for everything: the mark's own centre. Odd widths round the
	// same way, so the name and the line never sit a column off the mark.
	const axis = left + markCols / 2;
	return {
		size,
		top,
		left,
		markCols,
		markRows,
		axis,
		nameRow: top + markRows + 1,
		nameLeft: Math.max(0, Math.round(axis - INTRO_NAME.length / 2)),
		lineRow: top + markRows + 3,
		lineLeft: Math.max(0, Math.round(axis - INTRO_LINE.length / 2)),
		hintRow: Math.max(top + height + 1, rows - 2),
	};
}

// ------------------------------------------------------------------ motion

/** A fixed 32-bit hash, so the ring and the twinkle are the same every run. */
export function hash(a: number, b = 0): number {
	let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
	h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35) >>> 0;
	return (h ^ (h >>> 13)) >>> 0;
}

const unit = (n: number) => n / 0x100000000;

export function easeOutCubic(t: number): number {
	const c = Math.max(0, Math.min(1, t));
	return 1 - (1 - c) ** 3;
}

/** Where dot `i` starts, in screen dots: on a wide ring around the centre. */
export function startOf(i: number, cols: number, rows: number): { x: number; y: number } {
	const W = cols * 2;
	const H = rows * 4;
	const ang = unit(hash(i, 1)) * Math.PI * 2;
	const rad = (0.55 + unit(hash(i, 2)) * 0.35) * (Math.hypot(W, H) / 2);
	return { x: W / 2 + Math.cos(ang) * rad, y: H / 2 + Math.sin(ang) * rad * 0.9 };
}

/** Flight progress of dot `i` at `t` ms, eased: 0 on the ring, 1 home. */
export function flight(i: number, t: number): number {
	const delay = unit(hash(i, 3)) * STAGGER_MAX_MS;
	return easeOutCubic((t - delay) / FLIGHT_MS);
}

/**
 * Colour keys, dim to hot. Travelling dots brighten as they near home; home
 * dots are amber at the top and orange at the bottom; the pulse and the crest
 * of the living wave lift them toward a pale amber. Hues stay 20 to 35
 * degrees: no purple, no pink.
 */
export const INTRO_PALETTE = {
	far: "#4A3A2E",
	near: "#8B3F12",
	top: "#F07A28",
	bottom: "#E8610A",
	lift: "#F59A52",
	hot: "#FFC48C",
	name: "#FAF7F4",
	nameDim: "#8A8078",
	line: "#C8C2BA",
	lineDim: "#5F5A55",
	hint: "#8A8078",
} as const;

export type ColourKey = keyof typeof INTRO_PALETTE;

export interface Run {
	text: string;
	colour: ColourKey | null;
	bold?: boolean;
}

/** Strength order for picking one colour per cell. */
const RANK: Record<ColourKey, number> = {
	far: 1,
	near: 2,
	bottom: 3,
	top: 4,
	lift: 5,
	hot: 6,
	name: 0,
	nameDim: 0,
	line: 0,
	lineDim: 0,
	hint: 0,
};

/**
 * Whether dot `i` is dark for this beat of the living mark. About one dot in
 * seventy blinks off for one 125 ms beat: enough to read as alive, too sparse
 * to read as a pattern.
 */
export function twinkleOff(i: number, t: number): boolean {
	const beat = Math.floor(t / ALIVE_FRAME_MS);
	return hash(i, 1000 + beat) % 70 === 0;
}

/** The living wave at a dot, 0..1: a slow crest travelling down the stroke. */
export function waveAt(y: number, h: number, t: number): number {
	const beat = Math.floor(t / ALIVE_FRAME_MS) * ALIVE_FRAME_MS;
	const phase = beat / ALIVE_WAVE_MS - y / Math.max(1, h);
	return 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
}

export interface FrameOptions {
	/** The mark stays alive after it lands. Off under NO_COLOR and TERM=dumb. */
	alive: boolean;
	/** The quiet line near the bottom, e.g. "any key skips · v0.17.3". */
	hint?: string;
}

/**
 * The splash at `t` ms: one array of runs per terminal row. Deterministic.
 */
export function introFrame(
	cols: number,
	rows: number,
	layout: IntroLayout,
	dots: readonly Dot[],
	t: number,
	opts: FrameOptions,
): Run[][] {
	const cells = new Map<number, { bits: number; colour: ColourKey }>();
	const markH = layout.markRows * 4;
	const landed = t >= LANDED_MS;
	const pulse = t >= LANDED_MS && t < LANDED_MS + PULSE_MS;
	dots.forEach((d, i) => {
		const hx = layout.left * 2 + d.x;
		const hy = layout.top * 4 + d.y;
		let x = hx;
		let y = hy;
		let colour: ColourKey;
		const p = flight(i, t);
		if (p < 1) {
			const s = startOf(i, cols, rows);
			x = s.x + (hx - s.x) * p;
			y = s.y + (hy - s.y) * p;
			colour = p < 0.45 ? "far" : p < 0.85 ? "near" : d.y < markH / 2 ? "top" : "bottom";
		} else if (pulse) {
			colour = "hot";
		} else {
			colour = d.y < markH / 2 ? "top" : "bottom";
			if (landed && opts.alive) {
				if (twinkleOff(i, t)) return;
				const w = waveAt(d.y, markH, t);
				if (w > 0.8) colour = "lift";
			}
		}
		const xi = Math.round(x);
		const yi = Math.round(y);
		if (xi < 0 || yi < 0 || xi >= cols * 2 || yi >= rows * 4) return;
		const key = Math.floor(yi / 4) * cols + Math.floor(xi / 2);
		const bit = BITS.find(([dx, dy]) => dx === xi % 2 && dy === yi % 4)?.[2] ?? 0;
		const cell = cells.get(key);
		if (!cell) cells.set(key, { bits: bit, colour });
		else {
			cell.bits |= bit;
			if (RANK[colour] > RANK[cell.colour]) cell.colour = colour;
		}
	});

	const textAt = (r: number): { left: number; runs: Run[]; width: number } | null => {
		if (r === layout.hintRow && opts.hint) {
			return {
				left: Math.max(0, Math.round(layout.axis - opts.hint.length / 2)),
				runs: [{ text: opts.hint, colour: "hint" }],
				width: opts.hint.length,
			};
		}
		const k = (t - TEXT_AT_MS) / TEXT_FADE_MS;
		if (k < 0) return null;
		const step = k < 1 / 3 ? 0 : k < 2 / 3 ? 1 : 2;
		if (r === layout.nameRow) {
			const runs: Run[] =
				step === 0
					? [{ text: INTRO_NAME, colour: "nameDim", bold: true }]
					: [
							{ text: "8", colour: step === 2 ? "top" : "near", bold: true },
							{ text: "gent", colour: step === 2 ? "name" : "nameDim", bold: true },
							{ text: " Code", colour: step === 2 ? "hint" : "lineDim" },
						];
			return { left: layout.nameLeft, runs, width: INTRO_NAME.length };
		}
		if (r === layout.lineRow) {
			return {
				left: layout.lineLeft,
				runs: [{ text: INTRO_LINE, colour: step === 2 ? "line" : "lineDim" }],
				width: INTRO_LINE.length,
			};
		}
		return null;
	};

	const out: Run[][] = [];
	for (let r = 0; r < rows; r++) {
		const row: Run[] = [];
		const push = (text: string, colour: ColourKey | null, bold?: boolean) => {
			const last = row[row.length - 1];
			// A blank cell's colour is invisible (no background is set), so it joins
			// whatever run it follows. A row then breaks only at a real colour
			// change: a handful of Ink nodes per row instead of one per dot, which
			// keeps each frame's layout cheap while hundreds of dots are in flight.
			if (last && colour === null && !bold && text.trim() === "") {
				last.text += text;
				return;
			}
			if (last && last.colour === colour && Boolean(last.bold) === Boolean(bold)) last.text += text;
			else row.push(bold ? { text, colour, bold } : { text, colour });
		};
		const text = textAt(r);
		for (let c = 0; c < cols; c++) {
			if (text && c === text.left) {
				for (const run of text.runs) push(run.text, run.colour, run.bold);
				c += text.width - 1;
				continue;
			}
			const cell = cells.get(r * cols + c);
			if (cell) push(String.fromCodePoint(0x2800 + cell.bits), cell.colour);
			else push(" ", null);
		}
		// Trailing blanks are not drawn.
		const last = row[row.length - 1];
		if (last) {
			last.text = last.text.trimEnd();
			if (!last.text) row.pop();
		}
		out.push(row);
	}
	return out;
}

/** The dots of the mark for a layout, computed once per size. */
const DOTS = new Map<IntroSize, Dot[]>();
export function introDots(size: IntroSize): Dot[] {
	let d = DOTS.get(size);
	if (!d) {
		d = dotsOf(MARK_INTRO[size]);
		DOTS.set(size, d);
	}
	return d;
}
