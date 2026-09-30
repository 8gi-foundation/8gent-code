/**
 * Width math for the chat column of the three-zone shell.
 *
 * Pure functions, no React or Ink. The chat column is whatever the frame
 * leaves after the side columns, and every bubble inside it is sized from
 * that number, so it has to be the real one. The old guess subtracted 8
 * slack columns and the rails' rounded-up widths, which cost the chat 7
 * columns at 160 wide; the assistant bubble then took 78% of what was left
 * and wrapped a reply at 62 columns in a 92-column box (audit 2026-09-29, #5).
 */

/** Outer shell: single border (2) plus paddingX={1} (2). */
const SHELL_CHROME = 4;
/** Ink `gap={1}` between neighbouring columns. */
const COLUMN_GAP = 1;
/** ActivityRail's fixed width. */
export const ACTIVITY_RAIL_WIDTH = 34;

export interface ShellColumns {
	/** Width of the PLAN column when it is showing, else 0 / undefined. */
	planWidth?: number;
	activity: boolean;
}

/** Columns the chat column really gets, never below `min`. */
export function chatColumnWidth(cols: number, shell: ShellColumns, min = 24): number {
	let width = cols - SHELL_CHROME;
	if (shell.planWidth && shell.planWidth > 0) width -= shell.planWidth + COLUMN_GAP;
	if (shell.activity) width -= ACTIVITY_RAIL_WIDTH + COLUMN_GAP;
	return Math.max(min, width);
}

/** Share of the column a user bubble takes; the rest is the reply side's margin. */
export const USER_BUBBLE_SHARE = 0.78;

/**
 * Bubble and wrap widths for one message. The bubble's left bar and its
 * padding take 2 columns. A user message keeps the 78% bubble so the two
 * voices read as a conversation; the assistant's reply is the main thing on
 * screen and gets the full column (mockup A, chat first). The wrap width
 * keeps 2 columns of slack for odd glyph widths.
 */
export function bubbleWidths(
	contentWidth: number,
	role: "user" | "assistant" | "system" | "tool",
): { bubble: number; wrap: number } {
	const inner = Math.max(16, contentWidth - 2);
	const bubble = role === "user" ? Math.max(16, Math.floor(inner * USER_BUBBLE_SHARE)) : inner;
	return { bubble, wrap: Math.max(8, bubble - 2) };
}
