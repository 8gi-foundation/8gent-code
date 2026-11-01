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

import { chromeTier } from "./chrome-tier.js";

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
	/** False in the keys-up layout (#4967): no frame, so no border or padding to subtract. */
	framed?: boolean;
}

/** Columns the chat column really gets, never below `min`. */
export function chatColumnWidth(cols: number, shell: ShellColumns, min = 24): number {
	let width = cols - (shell.framed === false ? 0 : SHELL_CHROME);
	if (shell.planWidth && shell.planWidth > 0) width -= shell.planWidth + COLUMN_GAP;
	if (shell.activity) width -= ACTIVITY_RAIL_WIDTH + COLUMN_GAP;
	return Math.max(min, width);
}

/**
 * Rows the shell keeps for itself while an overlay sheet is open: tab row, status
 * row and footer when the keyboard is up (keys-up, #4967), the roomy chrome
 * otherwise. One place owns the number (#5034).
 */
export function chromeRows(rows: number, cols: number): number {
	return chromeTier(rows, cols) === "keys-up" ? 3 : 11;
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

/** Under this wrap width a reply's "3.2s · 412 tok" joins the sender row instead of taking its own. */
const INLINE_FOOTER_BELOW = 60;
/** "◆ 8gent " plus "04:21 PM" plus " · ": what the sender row already holds. */
const SENDER_ROW_CELLS = 8 + 8 + 3;

/** True when the footer can ride the sender row: narrow column and the whole line fits. */
export function footerRidesSenderRow(wrap: number, footer: string): boolean {
	return wrap < INLINE_FOOTER_BELOW && SENDER_ROW_CELLS + footer.length <= wrap;
}

/** "3.2s · 412 tok", or "900ms · 88 tok". */
export function replyFooter(latencyMs: number, tokens: number): string {
	const latency = latencyMs >= 1000 ? `${(latencyMs / 1000).toFixed(1)}s` : `${latencyMs}ms`;
	const tok =
		tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k tok` : `${tokens} tok`;
	return `${latency} · ${tok}`;
}
