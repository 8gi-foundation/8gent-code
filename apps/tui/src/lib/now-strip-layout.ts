/**
 * Width budget for the NOW strip above the chat (LiveFocalStrip).
 *
 * Pure functions, no React or Ink. The strip is one row:
 *
 *   ● DONE Planning   finished 2:06 AM        qwen3.8:27b-mlx ctx ███░░░ 41K tok
 *   └ state (fixed) ┘ └ what is happening ┘   └ route ┘ └ meter ┘ └ tokens ┘
 *
 * The old layout gave the right cluster a fixed 42 columns, so on an 80
 * column terminal the state text in the middle was the thing that got cut:
 * "finis…" (audit #9). Here the state word is never cut. The variable text
 * gives way instead, in order: the route (the model name, cut in the middle),
 * then the route entirely, then the ctx meter. The token count stays. When
 * even that leaves too little room, the clock after "finished" goes before
 * the word does.
 */

import { cellWidth, truncateMiddle } from "./header-layout.js";

/** Columns the state label and the mode take on the left. */
export const NOW_LABEL_WIDTH = 22;
/** Round or single border (2) plus paddingX={1} (2). */
const STRIP_CHROME = 4;
/** paddingX={1} around the middle text. */
const MIDDLE_PADDING = 2;
/** " ctx " before the meter. */
const CTX_LABEL = 5;
/** Shortest route slice worth drawing; below this the route is hidden. */
const ROUTE_MIN = 8;
/** Meter cells at full size. */
export const METER_CELLS = 10;

export interface NowStripInput {
	/** Strip width in columns, borders included. */
	width: number;
	/** The middle text, e.g. "finished 2:06 AM", "idle", or the active step. */
	middle: string;
	/** Columns of the middle text that must never be cut ("finished", "idle"). */
	middleMin: number;
	/** The same state without its clock, used when the clock does not fit. */
	middleShort?: string;
	route: string;
	tokens: string;
}

export interface NowStripFit {
	middle: string;
	/** "" when the route is dropped. */
	route: string;
	/** False when the meter is dropped. */
	meter: boolean;
	/** Columns the right cluster takes. */
	rightWidth: number;
}

function rightWidth(route: string, meter: boolean, tokens: string): number {
	const routeW = route ? cellWidth(route) : 0;
	const meterW = meter ? CTX_LABEL + METER_CELLS : 0;
	return routeW + meterW + 1 + cellWidth(tokens);
}

/** Fit the strip into `width` columns. */
export function fitNowStrip(input: NowStripInput): NowStripFit {
	const { width, middle, middleMin, middleShort, tokens } = input;
	const route = input.route && input.route !== "-" && input.route !== "\u2014" ? input.route : "";
	const room = Math.max(0, width - STRIP_CHROME - NOW_LABEL_WIDTH - MIDDLE_PADDING);
	const need = Math.max(middleMin, 0);
	const want = cellWidth(middle);

	const fits = (r: string, m: boolean, mid: number) => rightWidth(r, m, tokens) + mid <= room;

	// 1. Everything whole.
	if (fits(route, true, want)) return { middle, route, meter: true, rightWidth: rightWidth(route, true, tokens) };
	// 2. The route cut in the middle so the full middle text fits.
	if (route) {
		const routeRoom = room - want - rightWidth("", true, tokens);
		if (routeRoom >= ROUTE_MIN) {
			const r = truncateMiddle(route, routeRoom);
			return { middle, route: r, meter: true, rightWidth: rightWidth(r, true, tokens) };
		}
	}
	// 3. No route, then no meter either, the full middle text kept.
	for (const meter of [true, false]) {
		if (fits("", meter, want)) return { middle, route: "", meter, rightWidth: rightWidth("", meter, tokens) };
	}
	// 4. The middle cut down to its protected head (a long active step).
	for (const meter of [true, false]) {
		if (need < want && fits("", meter, need)) {
			return { middle, route: "", meter, rightWidth: rightWidth("", meter, tokens) };
		}
	}
	// 5. Too narrow for the clock: drop it, keep the word.
	const short = middleShort ?? middle;
	return { middle: short, route: "", meter: false, rightWidth: rightWidth("", false, tokens) };
}
