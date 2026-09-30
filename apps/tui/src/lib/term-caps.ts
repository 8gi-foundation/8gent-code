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
 * Always pass colours through Ink's colour props, so chalk steps down to 256
 * or 16 colours by itself; NO_COLOR is enforced on stdout by
 * lib/colour-policy.ts.
 */

import { colourPolicy } from "./colour-policy.js";

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
 * False when the terminal draws no colour at all. Same precedence as the
 * stdout colour policy (lib/colour-policy.ts): an explicit FORCE_COLOR wins,
 * then NO_COLOR (non-empty) or TERM=dumb turn colour off. Every colour is
 * dropped there, backgrounds included, so a tinted code chip would read as
 * plain text; callers keep the backticks.
 */
export function drawsColour(env: Env = process.env): boolean {
	return colourPolicy(env) !== "none";
}
