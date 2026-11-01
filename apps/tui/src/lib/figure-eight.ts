/**
 * The working spinner traces a figure of eight, not a square.
 *
 * A braille cell is a 2x4 grid of dots, so a single lit dot can sit in any of
 * eight positions. The stock braille spinner walks its dot around the outside
 * of that cell, which reads as a small square turning. This path instead runs
 * two loops joined in the middle: up the left side, across the top, down to
 * the centre, then diagonally across into the lower loop and back again. The
 * two diagonal strokes cross in the middle of the cell, and that crossing is
 * what makes the motion read as an 8 rather than a ring.
 *
 * Dot bit values inside a braille cell (character is U+2800 plus the bits):
 *
 *            col 0        col 1
 *   row 0    dot1 0x01    dot4 0x08
 *   row 1    dot2 0x02    dot5 0x10
 *   row 2    dot3 0x04    dot6 0x20
 *   row 3    dot7 0x40    dot8 0x80
 *
 * Everything here is pure so the shape can be tested without a terminal.
 */

export interface CellPoint {
	readonly col: number;
	readonly row: number;
}

/** First code point of the braille block; dot bits are added to it. */
export const BRAILLE_BASE = 0x2800;

/** How long each frame is held. Slow enough to read as motion, not a flicker. */
export const FIGURE_EIGHT_INTERVAL_MS = 90;

/**
 * The eight cell positions in travel order. Starting at the middle of the left
 * column keeps the first frame on the crossing point, so a spinner that only
 * lives for a moment still looks like part of an 8.
 */
export const FIGURE_EIGHT_PATH: readonly CellPoint[] = [
	{ col: 0, row: 1 },
	{ col: 0, row: 0 },
	{ col: 1, row: 0 },
	{ col: 1, row: 1 },
	{ col: 0, row: 2 },
	{ col: 0, row: 3 },
	{ col: 1, row: 3 },
	{ col: 1, row: 2 },
];

const DOT_BITS: readonly (readonly number[])[] = [
	[0x01, 0x02, 0x04, 0x40],
	[0x08, 0x10, 0x20, 0x80],
];

/** The braille bit for one cell position. */
export function dotBit(point: CellPoint): number {
	const column = DOT_BITS[point.col];
	if (!column) throw new Error(`figure-eight: column out of range: ${point.col}`);
	const bit = column[point.row];
	if (bit === undefined) throw new Error(`figure-eight: row out of range: ${point.row}`);
	return bit;
}

/**
 * Each frame lights the current position and the one before it, so the dot
 * reads as a moving head with a short tail rather than a blinking pixel.
 */
export const FIGURE_EIGHT_FRAMES: readonly string[] = FIGURE_EIGHT_PATH.map((point, index) => {
	const previous =
		FIGURE_EIGHT_PATH[(index - 1 + FIGURE_EIGHT_PATH.length) % FIGURE_EIGHT_PATH.length];
	return String.fromCodePoint(BRAILLE_BASE | dotBit(point) | dotBit(previous));
});

/** The frame for a tick count. Negative ticks wrap the same way as positive. */
export function figureEightFrame(tick: number): string {
	const count = FIGURE_EIGHT_FRAMES.length;
	const frame = FIGURE_EIGHT_FRAMES[((tick % count) + count) % count];
	// The modulo above always lands in range; the check keeps the type honest.
	return frame ?? FIGURE_EIGHT_FRAMES[0]!;
}

/** Shown when animations are off, so the row keeps its width and meaning. */
export const FIGURE_EIGHT_STILL = FIGURE_EIGHT_FRAMES[0]!;
