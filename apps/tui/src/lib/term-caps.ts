/**
 * Terminal glyph capability, one shared check.
 *
 * The HUD uses braille (the figure-8), ✓ ✗ ⊘, ● and box-drawing rules. The
 * Linux text console and the legacy Windows console draw those as empty
 * boxes. On those terminals we fall back to plain ASCII.
 *
 * Unicode-rich unless:
 * - EIGHT_ASCII=1 (explicit opt-out, any platform);
 * - TERM=linux (the Linux virtual console);
 * - Windows without WT_SESSION and without TERM_PROGRAM (the legacy console
 *   host; Windows Terminal sets WT_SESSION, VS Code and others set
 *   TERM_PROGRAM).
 *
 * Colour is not handled here: always pass colours through Ink's colour
 * props, so chalk steps down to 256 or 16 colours by itself.
 */

type Env = Record<string, string | undefined>;

export function unicodeRich(env: Env = process.env, platform: string = process.platform): boolean {
	if (env.EIGHT_ASCII === "1") return false;
	if (env.TERM === "linux") return false;
	if (platform === "win32" && !env.WT_SESSION && !env.TERM_PROGRAM) return false;
	return true;
}

export interface Glyphs {
	/** The figure-8 when it cannot be drawn in braille. */
	eight: string | null;
	ok: string;
	/** A step not started yet. */
	pending: string;
	fail: string;
	blocked: string;
	dot: string;
	diamond: string;
	/** Thin rule and the heavier bar drawn on it. */
	rule: string;
	bar: string;
	/** Unordered list marker in chat replies. */
	bullet: string;
	/** The thin rule in front of a code block. */
	gutter: string;
}

const RICH: Glyphs = {
	eight: null,
	ok: "✓",
	pending: "○",
	fail: "✗",
	blocked: "⊘",
	dot: "●",
	diamond: "◆",
	rule: "─",
	bar: "━",
	bullet: "•",
	gutter: "│",
};

const ASCII: Glyphs = {
	eight: "8",
	ok: "+",
	pending: "o",
	fail: "x",
	blocked: "-",
	dot: "*",
	diamond: "*",
	rule: "-",
	bar: "=",
	bullet: "-",
	gutter: "|",
};

export function glyphs(env?: Env, platform?: string): Glyphs {
	return unicodeRich(env, platform) ? RICH : ASCII;
}

/**
 * False when the terminal draws no colour at all (NO_COLOR set, or
 * TERM=dumb). Chalk drops every colour there, backgrounds included, so a
 * tinted code chip would read as plain text; callers keep the backticks.
 */
export function drawsColour(env: Env = process.env): boolean {
	if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
	if (env.TERM === "dumb") return false;
	return true;
}
