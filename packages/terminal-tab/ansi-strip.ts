/**
 * @8gent/terminal-tab — ansi-strip.ts
 *
 * Removes terminal control sequences (cursor moves, clears, mode toggles,
 * OSC titles, carriage returns) while preserving SGR colour/style codes
 * so the line-streaming view in TerminalView can render rich output
 * without trying to honour cursor positioning.
 *
 * Limitation: this is *not* a vt100 emulator. Apps that rely on cursor
 * positioning (vim, less, htop) will look wrong here. Tier 2 of the PTY
 * tab plan handles that case by suspending Ink and writing the PTY
 * stream straight to process.stdout when alt-screen is detected.
 */

const ESC = "\x1b";

/**
 * Match any CSI sequence: ESC [ ?-prefix? params final-letter.
 * Final letter is matched broadly; the strip helper decides whether
 * to keep (SGR = lowercase 'm') or drop based on the final byte.
 */
const CSI =
	// eslint-disable-next-line no-control-regex
	/\x1b\[\??[0-9;]*[A-Za-z]/g;

/** Match save/restore cursor (DECSC = ESC 7, DECRC = ESC 8). */
// eslint-disable-next-line no-control-regex
const DECSC_DECRC = /\x1b[78]/g;

/**
 * Match OSC sequences terminated by BEL (\x07) or ST (ESC \).
 * Used by terminals to set the window title, hyperlink URLs, etc.
 */
const OSC =
	// eslint-disable-next-line no-control-regex
	/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Standalone carriage return overwrites the current line in a real
 * terminal. For the line-streaming view we mimic that by dropping
 * everything since the last newline up to and including the CR.
 */
const CR_OVERWRITE =
	// eslint-disable-next-line no-control-regex
	/[^\n]*\r(?!\n)/g;

/**
 * Strip all control sequences except SGR (colour/style) and newlines.
 *
 * Designed for chunked input: a trailing partial ESC sequence at the
 * end of the buffer is left intact so the caller can prepend the next
 * chunk before stripping again.
 */
export function stripControl(input: string): string {
	if (!input) return input;
	return input
		.replace(OSC, "") // ESC ] ... BEL/ST
		.replace(CSI, (m) => (m.endsWith("m") ? m : "")) // keep SGR
		.replace(DECSC_DECRC, "") // ESC 7 / ESC 8
		.replace(CR_OVERWRITE, ""); // bare \r overwrites preceding text
}

/**
 * Detect alt-screen enable. Apps like vim/less switch to alt-screen
 * via \x1b[?1049h (modern) or \x1b[?47h (legacy).
 */
export function hasAltScreenEnter(input: string): boolean {
	return input.includes(`${ESC}[?1049h`) || input.includes(`${ESC}[?47h`);
}

/** Detect alt-screen disable. Pair of hasAltScreenEnter. */
export function hasAltScreenExit(input: string): boolean {
	return input.includes(`${ESC}[?1049l`) || input.includes(`${ESC}[?47l`);
}
