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
	fail: string;
	blocked: string;
	dot: string;
	diamond: string;
	/** Thin rule and the heavier bar drawn on it. */
	rule: string;
	bar: string;
}

const RICH: Glyphs = {
	eight: null,
	ok: "✓",
	fail: "✗",
	blocked: "⊘",
	dot: "●",
	diamond: "◆",
	rule: "─",
	bar: "━",
};

const ASCII: Glyphs = {
	eight: "8",
	ok: "+",
	fail: "x",
	blocked: "-",
	dot: "*",
	diamond: "*",
	rule: "-",
	bar: "=",
};

export function glyphs(env?: Env, platform?: string): Glyphs {
	return unicodeRich(env, platform) ? RICH : ASCII;
}
