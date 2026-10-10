/**
 * 8gent Code - measured layout of a design mock-up (#3770).
 *
 * Pilot design-mockup-practice scored 22 of 23 checks; the one miss was
 * d2_position (0.7239 against 0.77). The mock-up is 1280 px wide with an 800 px
 * column at x=240. read_image hands a model that can see a copy downscaled to
 * 1024 px, so every coordinate it guessed was 0.8 of the real one, and it built
 * a 1080 px column with 24 px padding. Position is scored in page space, so the
 * blocks sat off the mock-up even though the words and colours were right.
 *
 * This reads the full-size pixels and reports the content column, whether it is
 * centred, and each horizontal band of content with its x-extents. It is
 * read-only, model-free and bounded; any failure returns nothing, never an
 * error, so read_image behaves as before.
 */

import sharp from "sharp";

/** Grey levels a pixel must differ from the background by to count as content. */
const INK_THRESHOLD = 40;
/** Rows of blank between two bands for them to be separate blocks. */
const BAND_GAP = 6;
/** Columns of blank between two spans in one band for them to be separate blocks. */
const SPAN_GAP = 16;
const MAX_PIXELS = 40_000_000;
const MAX_BANDS = 40;
const MAX_ROWS = 12;
const CENTER_TOLERANCE = 4;

/** A line of content inside one span of a multi-span band (#3823). */
export type Row = { y: number; h: number };
export type Span = { x: number; w: number; rows?: Row[] };
export type Band = { y: number; h: number; x: number; w: number; spans: Span[] };
export type LayoutMeasure = {
	width: number;
	height: number;
	column: { left: number; right: number; width: number };
	centered: boolean;
	bands: Band[];
};

export async function measureLayout(file: string): Promise<LayoutMeasure | null> {
	try {
		const { data, info } = await sharp(file, { limitInputPixels: MAX_PIXELS })
			.flatten({ background: "#ffffff" })
			.greyscale()
			.raw()
			.toBuffer({ resolveWithObject: true });
		const { width, height } = info;
		if (width < 2 || height < 2) return null;
		const bg = data[0];
		const ink = (i: number) => Math.abs(data[i] - bg) > INK_THRESHOLD;

		const rowInk = new Uint8Array(height);
		for (let y = 0; y < height; y++) {
			const base = y * width;
			for (let x = 0; x < width; x++)
				if (ink(base + x)) {
					rowInk[y] = 1;
					break;
				}
		}

		const ranges: Array<[number, number]> = [];
		let start = -1;
		let blank = 0;
		for (let y = 0; y < height; y++) {
			if (rowInk[y]) {
				if (start < 0) start = y;
				blank = 0;
			} else if (start >= 0 && ++blank > BAND_GAP) {
				ranges.push([start, y - blank]);
				start = -1;
			}
		}
		if (start >= 0) ranges.push([start, height - 1 - blank]);
		if (ranges.length === 0) return null;

		const rowsIn = (y0: number, y1: number, x0: number, x1: number): Row[] => {
			const out: Row[] = [];
			let st = -1;
			let bl = 0;
			for (let y = y0; y <= y1; y++) {
				let has = false;
				const base = y * width;
				for (let x = x0; x < x1 && !has; x++) if (ink(base + x)) has = true;
				if (has) {
					if (st < 0) st = y;
					bl = 0;
				} else if (st >= 0 && ++bl > BAND_GAP) {
					out.push({ y: st, h: y - bl - st + 1 });
					st = -1;
				}
			}
			if (st >= 0) out.push({ y: st, h: y1 - bl - st + 1 });
			return out;
		};

		const bands: Band[] = ranges.map(([y0, y1]) => {
			const colInk = new Uint8Array(width);
			for (let y = y0; y <= y1; y++) {
				const base = y * width;
				for (let x = 0; x < width; x++) if (!colInk[x] && ink(base + x)) colInk[x] = 1;
			}
			const spans: Span[] = [];
			let s = -1;
			let gap = 0;
			for (let x = 0; x < width; x++) {
				if (colInk[x]) {
					if (s < 0) s = x;
					gap = 0;
				} else if (s >= 0 && ++gap > SPAN_GAP) {
					spans.push({ x: s, w: x - gap - s + 1 });
					s = -1;
				}
			}
			if (s >= 0) spans.push({ x: s, w: width - gap - s });
			// #3823: a paragraph beside an image shares one band with it, which hid the
			// paragraph's own line tops. Split each span of a side-by-side band again.
			if (spans.length > 1) {
				for (const sp of spans) {
					const rows = rowsIn(y0, y1, sp.x, sp.x + sp.w);
					if (rows.length > 1) sp.rows = rows.slice(0, MAX_ROWS);
				}
			}
			const left = spans[0].x;
			const right = spans[spans.length - 1].x + spans[spans.length - 1].w;
			return { y: y0, h: y1 - y0 + 1, x: left, w: right - left, spans };
		});

		const left = Math.min(...bands.map((b) => b.x));
		const right = Math.max(...bands.map((b) => b.x + b.w));
		const centered = Math.abs(left - (width - right)) <= CENTER_TOLERANCE;
		return {
			width,
			height,
			column: { left, right, width: right - left },
			centered,
			bands: bands.slice(0, MAX_BANDS),
		};
	} catch {
		return null;
	}
}

/** One block of text for a read_image result, or "" when there is nothing to say. */
export async function layoutMeasureLine(file: string): Promise<string> {
	const m = await measureLayout(file);
	if (!m) return "";
	const rows = m.bands.map((b) => {
		const spans = b.spans
			.map((s) => {
				const off = s.x - m.column.left;
				const at = off > 0 ? `x=${s.x} (+${off} from column left)` : `x=${s.x}`;
				const rows = s.rows ? ` [lines: ${s.rows.map((r) => `y=${r.y} h=${r.h}`).join(", ")}]` : "";
				return `${at} w=${s.w}${rows}`;
			})
			.join(" | ");
		return `  y=${b.y} h=${b.h}: ${spans}`;
	});
	return [
		`Measured layout of the full-size image (${m.width}x${m.height} px; any copy you see is downscaled, so use these numbers, not coordinates read off the view):`,
		`  content column x=${m.column.left}..${m.column.right} (width ${m.column.width}px, left margin ${m.column.left}px, right margin ${m.width - m.column.right}px${m.centered ? ", centered" : ""})`,
		"  content bands, top to bottom (y is the top edge, h the height, x the left edge, w the width):",
		...rows,
		`When you rebuild this as a page, match these positions: a ${m.column.width}px-wide column${m.centered ? " centered in the page" : ""}, with block tops, heights and side-by-side widths as listed. Do not widen the column, add extra padding or insert extra margins.`,
		"These are the edges of the visible pixels (ink), not CSS boxes: a text box starts a few px above its y (half the line gap), and a table or list cell holding text at x greater than the column left needs that much left padding. Reproduce every listed x offset and every y gap. If a block is still off after the first render, place it with position:absolute at the listed left and top inside a position:relative column rather than relying on flow.",
	].join("\n");
}
