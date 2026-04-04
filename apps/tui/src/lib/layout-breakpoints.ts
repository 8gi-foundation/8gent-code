/**
 * Terminal width helpers so chat, process sidebar, and status chrome stay readable.
 */

/** Below this width the process sidebar uses a slimmer cap and higher main-area floor. */
export const TUI_NARROW_WIDTH = 88;

/** Below this width the agent mode strip shows only the active mode. */
export const TUI_AGENT_MODE_COMPACT_BELOW = 78;

/** Enhanced status bar switches to single-line compact layout below this column count. */
export const TUI_STATUS_COMPACT_BELOW = 92;

const RESERVED_CHROME = 8;

const SIDEBAR_MAX_WIDE = 32;
const SIDEBAR_MAX_NARROW = 26;
const SIDEBAR_MIN = 18;

/**
 * Process sidebar width when open. Shrinks when the terminal is narrow so chat keeps a usable slice.
 */
export function computeProcessSidebarWidth(
	sidebarOpen: boolean,
	viewportWidth: number,
): number {
	if (!sidebarOpen) return 0;
	const narrow = viewportWidth < TUI_NARROW_WIDTH;
	const mainFloor = narrow ? 26 : 34;
	const maxByViewport = Math.max(
		SIDEBAR_MIN,
		viewportWidth - RESERVED_CHROME - mainFloor,
	);
	const cap = narrow ? SIDEBAR_MAX_NARROW : SIDEBAR_MAX_WIDE;
	return Math.min(cap, maxByViewport);
}

/** Inner width passed to MessageList and similar (approximate content columns). */
export function tuiChatContentWidth(
	viewportWidth: number,
	sidebarWidth: number,
): number {
	return Math.max(16, viewportWidth - sidebarWidth - RESERVED_CHROME);
}
