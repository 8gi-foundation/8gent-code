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
