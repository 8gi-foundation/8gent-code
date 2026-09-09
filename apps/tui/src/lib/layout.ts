/**
 * Layout math helpers for terminal UI.
 * Pure functions, no dependencies on React or Ink.
 */

/** Clamp a value between min and max (inclusive). */
export function clamp(value: number, min: number, max: number): number {
	if (min > max) return min;
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

/**
 * Calculate the width of each column given total width, number of columns,
 * and optional gap between columns. Returns at least 0.
 */
export function columnWidth(totalWidth: number, columns: number, gap = 0): number {
	if (columns <= 0) return 0;
	if (columns === 1) return Math.max(0, totalWidth);
	const totalGap = gap * (columns - 1);
	return Math.max(0, Math.floor((totalWidth - totalGap) / columns));
}

/**
 * Determine how many columns fit given the available width,
 * a minimum item width, and an optional gap between columns.
 * Returns at least 1 if there are items, 0 if items is 0.
 */
export function fitColumns(items: number, maxWidth: number, minItemWidth: number, gap = 0): number {
	if (items <= 0) return 0;
	if (minItemWidth <= 0) return items;
	if (maxWidth <= 0) return 1;

	// Binary-style: increment columns while they fit
	let cols = 1;
	while (cols < items) {
		const needed = cols * minItemWidth + (cols - 1) * gap;
		if (needed > maxWidth) break;
		const nextNeeded = (cols + 1) * minItemWidth + cols * gap;
		if (nextNeeded > maxWidth) break;
		cols++;
	}

	return cols;
}

/**
 * Distribute total width among items according to weight ratios.
 * Returns an integer array that sums to totalWidth (remainder goes to
 * the first items). Empty weights array returns [].
 */
export function distributeWidths(totalWidth: number, weights: number[]): number[] {
	if (weights.length === 0) return [];
	if (totalWidth <= 0) return weights.map(() => 0);

	const totalWeight = weights.reduce((sum, w) => sum + Math.max(0, w), 0);
	if (totalWeight === 0) {
		// Equal distribution when all weights are zero
		const base = Math.floor(totalWidth / weights.length);
		const remainder = totalWidth - base * weights.length;
		return weights.map((_, i) => base + (i < remainder ? 1 : 0));
	}

	const rawWidths = weights.map((w) => Math.floor((Math.max(0, w) / totalWeight) * totalWidth));

	// Distribute remainder to maintain exact total
	const assigned = rawWidths.reduce((sum, w) => sum + w, 0);
	let remainder = totalWidth - assigned;
	for (let i = 0; i < rawWidths.length && remainder > 0; i++) {
		rawWidths[i]++;
		remainder--;
	}

	return rawWidths;
}

/**
 * Fixed chrome of the V2 three-zone shell (app.tsx). Kept here so the
 * popups (slash autocomplete, Ctrl+P palette) can size themselves from
 * the same numbers the shell lays out with, instead of guessing.
 */
export const SHELL_CHROME = {
	/** Outer main-box border (2) + paddingX (2). */
	frameCols: 4,
	/** ContextRail is a fixed 28-column bordered box. */
	contextRailCols: 28,
	/** LivePlanRail is a fixed 24-column box. */
	planRailCols: 24,
	/** ActivityRail is a fixed 34-column bordered box. */
	activityRailCols: 34,
	/** `gap={1}` between the rail children of the main box. */
	gapCols: 1,
	/**
	 * Rows outside the centre column: header (3) + tab bar (2) + main box
	 * border (2) + FM bar (3) + instrument tiles (3) + mode tiles (3) +
	 * focal strip (3).
	 */
	fixedRows: 19,
	/**
	 * HeaderBar wraps its right-hand cluster onto a second row below about
	 * 110 columns, which costs the centre column one more row. Reserved at
	 * every size so a popup never lands on the main frame's bottom border.
	 */
	safetyRows: 1,
} as const;

export interface PopupLayoutOptions {
	/** ContextRail + LivePlanRail are shown (cols >= 120). */
	contextRail: boolean;
	/** ActivityRail is shown (cols >= 90). */
	activityRail: boolean;
}

export interface PopupLayout {
	/** Usable width of the centre column, in columns. */
	width: number;
	/** How many command entries the slash autocomplete box may list. */
	slashRows: number;
	/** How many command entries the Ctrl+P palette may list. */
	paletteRows: number;
}

/** Width of the centre column between the rails. Never below `minWidth`. */
export function centerColumnWidth(
	viewportWidth: number,
	opts: PopupLayoutOptions,
	minWidth = 20,
): number {
	let width = viewportWidth - SHELL_CHROME.frameCols;
	if (opts.contextRail) {
		width -=
			SHELL_CHROME.contextRailCols +
			SHELL_CHROME.planRailCols +
			2 * SHELL_CHROME.gapCols;
	}
	if (opts.activityRail) {
		width -= SHELL_CHROME.activityRailCols + SHELL_CHROME.gapCols;
	}
	return Math.max(minWidth, width);
}

/**
 * Size budget for the two command popups. Both must fit inside the centre
 * column at any terminal size, so rows are derived from the viewport height
 * minus the shell chrome, and width from the column between the rails.
 *
 * Slash box chrome: border (2) + "Commands:" header (1), sitting under the
 * input row (1) and the ghost hint row (1). Palette chrome: border (2) +
 * query (1) + divider (1) + up/down markers (2) + footer (1).
 */
export function popupLayout(
	viewport: { width: number; height: number },
	opts: PopupLayoutOptions,
): PopupLayout {
	const width = centerColumnWidth(viewport.width, opts);
	const freeRows = viewport.height - SHELL_CHROME.fixedRows - SHELL_CHROME.safetyRows;
	return {
		width,
		slashRows: clamp(freeRows - 5, 3, 14),
		paletteRows: clamp(freeRows - 7, 3, 10),
	};
}

/**
 * V2 shell width budget. Chat first: the chat column keeps at least
 * CHAT_MIN_COLS text columns, and the side rails only appear while that
 * budget still holds. Rails drop in a fixed order as the terminal narrows:
 * the context rail plus plan column goes first, then the activity rail.
 * Everything the rails show is also in /status, so nothing is lost.
 */

/** Minimum text columns the chat column keeps while any rail is shown. */
export const CHAT_MIN_COLS = 60;
/** Columns taken by the context rail plus the plan column and their gaps. */
export const CONTEXT_RAIL_COLS = 55;
/** Columns taken by the activity rail and its gap. */
export const ACTIVITY_RAIL_COLS = 36;
/** Outer border, padding, gutter and slack around the chat column. */
export const SHELL_CHROME_COLS = 8;
/** Floor for the chat column when no rail is showing and the terminal is tiny. */
const CHAT_FLOOR_COLS = 24;

export interface ShellWidthBudget {
	/** Show the context rail and the plan column beside it. */
	showContextRail: boolean;
	/** Show the activity rail on the right. */
	showActivityRail: boolean;
	/** Text columns available to the chat column (MessageList, /help, and friends). */
	chatWidth: number;
}

/**
 * Decide which rails fit at a given terminal width and how wide the chat
 * column is once they are placed. Single source of truth for every consumer.
 *
 * Activity rail from 104 columns, both rails from 159 columns.
 */
export function shellWidthBudget(cols: number): ShellWidthBudget {
	const base = cols - SHELL_CHROME_COLS;
	const showActivityRail = base - ACTIVITY_RAIL_COLS >= CHAT_MIN_COLS;
	const showContextRail =
		showActivityRail && base - ACTIVITY_RAIL_COLS - CONTEXT_RAIL_COLS >= CHAT_MIN_COLS;
	const chatWidth = Math.max(
		CHAT_FLOOR_COLS,
		base - (showContextRail ? CONTEXT_RAIL_COLS : 0) - (showActivityRail ? ACTIVITY_RAIL_COLS : 0),
	);
	return { showContextRail, showActivityRail, chatWidth };
}
