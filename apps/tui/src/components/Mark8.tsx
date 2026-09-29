/**
 * Mark8 - the 8gent figure-8 mark, drawn from the precomputed cells in
 * lib/mark8-cells.ts (maths in lib/mark8.ts, design source mark8.py).
 *
 * Halfblock sizes paint two pixels per cell with the upper half block: the
 * top pixel is the foreground colour, the bottom pixel the background colour.
 * An empty pixel is left transparent, so the mark sits on whatever the
 * terminal background is; partial pixels blend toward the theme background.
 *
 * Colour only goes through Ink's colour props (never raw escapes), so chalk
 * steps it down to 256 or 16 colours by itself. On terminals that cannot draw
 * block or braille glyphs (lib/term-caps.ts) the mark is a plain bold "8".
 */

import { Box, Text } from "ink";
import React from "react";
import {
	type HalfblockMark,
	MARK_HEADER,
	MARK_INTRO,
	MARK_MEDIUM,
	MARK_SMALL,
} from "../lib/mark8-cells.js";
import { MARK_BOTTOM, MARK_TOP } from "../lib/mark8.js";
import { glyphs } from "../lib/term-caps.js";
import { t } from "../theme.js";

export type MarkSize = "intro" | "medium" | "small" | "header";

const HALFBLOCKS: Record<Exclude<MarkSize, "header">, HalfblockMark> = {
	intro: MARK_INTRO,
	medium: MARK_MEDIUM,
	small: MARK_SMALL,
};

/** Coverage below this is treated as empty, so faint halos never paint a box. */
const EMPTY_BELOW = 16;

/** Cell footprint of a size, for layout. The ASCII fallback is always 1 x 1. */
export function markSize(size: MarkSize, rich = glyphs().eight === null): { cols: number; rows: number } {
	if (!rich) return { cols: 1, rows: 1 };
	if (size === "header") return { cols: MARK_HEADER[0]?.length ?? 4, rows: MARK_HEADER.length };
	const m = HALFBLOCKS[size];
	return { cols: m.cols, rows: m.rows };
}

function hexToRgb(hex: string): [number, number, number] {
	const h = hex.replace("#", "");
	return [
		Number.parseInt(h.slice(0, 2), 16),
		Number.parseInt(h.slice(2, 4), 16),
		Number.parseInt(h.slice(4, 6), 16),
	];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
	return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function mix(a: [number, number, number], b: [number, number, number], k: number): [number, number, number] {
	return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** The stroke colour at pixel row y of h: amber at the top, orange at the bottom. */
export function strokeColor(y: number, h: number): [number, number, number] {
	return mix(hexToRgb(MARK_TOP), hexToRgb(MARK_BOTTOM), h > 1 ? y / (h - 1) : 0);
}

export interface MarkCell {
	glyph: " " | "▀" | "▄";
	color?: string;
	backgroundColor?: string;
}

/**
 * One row of cells for a halfblock mark, runs of identical cells merged so a
 * row is a handful of Text nodes rather than one per cell.
 */
export function halfblockRow(mark: HalfblockMark, row: number, bg: string = t.bg): { text: string; cell: MarkCell }[] {
	const top = mark.coverage[row * 2] ?? "";
	const bottom = mark.coverage[row * 2 + 1] ?? "";
	const h = mark.rows * 2;
	const bgRgb = hexToRgb(bg);
	const pixel = (hex: string, i: number, y: number): string | null => {
		const v = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
		if (v < EMPTY_BELOW) return null;
		return rgbToHex(mix(bgRgb, strokeColor(y, h), v / 255));
	};
	const runs: { text: string; cell: MarkCell }[] = [];
	for (let c = 0; c < mark.cols; c++) {
		const a = pixel(top, c, row * 2);
		const b = pixel(bottom, c, row * 2 + 1);
		let cell: MarkCell;
		if (a && b) cell = { glyph: "▀", color: a, backgroundColor: b };
		else if (a) cell = { glyph: "▀", color: a };
		else if (b) cell = { glyph: "▄", color: b };
		else cell = { glyph: " " };
		const last = runs[runs.length - 1];
		if (
			last &&
			last.cell.glyph === cell.glyph &&
			last.cell.color === cell.color &&
			last.cell.backgroundColor === cell.backgroundColor
		) {
			last.text += cell.glyph;
		} else {
			runs.push({ text: cell.glyph, cell });
		}
	}
	return runs;
}

interface Mark8Props {
	size: MarkSize;
	/** Override the capability check (tests). Defaults to lib/term-caps.ts. */
	rich?: boolean;
}

function Mark8Base({ size, rich = glyphs().eight === null }: Mark8Props) {
	if (!rich) {
		return (
			<Text color={t.orange} bold>
				8
			</Text>
		);
	}
	if (size === "header") {
		return (
			<Box flexDirection="column" flexShrink={0}>
				{MARK_HEADER.map((line, r) => (
					// Rows are positional and never reorder.
					// react-doctor-disable-next-line react-doctor/no-array-index-as-key
					<Text key={r} color={rgbToHex(strokeColor(r, MARK_HEADER.length))}>
						{line}
					</Text>
				))}
			</Box>
		);
	}
	const mark = HALFBLOCKS[size];
	return (
		<Box flexDirection="column" flexShrink={0}>
			{Array.from({ length: mark.rows }, (_, r) => (
				// Rows are positional and never reorder.
				// react-doctor-disable-next-line react-doctor/no-array-index-as-key
				<Text key={r}>
					{halfblockRow(mark, r).map((run, i) => (
						// Runs are positional within a fixed row.
						// react-doctor-disable-next-line react-doctor/no-array-index-as-key
						<Text key={i} color={run.cell.color} backgroundColor={run.cell.backgroundColor}>
							{run.text}
						</Text>
					))}
				</Text>
			))}
		</Box>
	);
}

/** Memoised: the splash re-renders while it types, the mark never changes with it. */
export const Mark8 = React.memo(Mark8Base);
