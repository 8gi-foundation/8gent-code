/**
 * Colour policy for everything the TUI writes (#3171).
 *
 * Why this exists: Ink 6 draws colour through its own copy of chalk 5, and
 * chalk's detection reads FORCE_COLOR and TERM but never NO_COLOR. So with
 * NO_COLOR=1 in a truecolour terminal chalk stays at level 3 and the whole HUD
 * is drawn in colour. This module restores the no-color.org contract.
 *
 * Precedence, first match wins:
 *   1. FORCE_COLOR set (any value, even empty): chalk's own reading stands.
 *      FORCE_COLOR=0 / false is chalk's "no styling at all"; 1 to 3 force
 *      colour on, even over NO_COLOR.
 *   2. NO_COLOR set to a non-empty value: no colour.
 *   3. TERM=dumb: no colour.
 *   4. Otherwise: chalk decides from the terminal (TTY, COLORTERM, TERM).
 *
 * "No colour" means colour only. no-color.org is explicit that bold,
 * underline and the like are not colour, and the input caret is drawn in
 * inverse, so dropping chalk to level 0 (which strips every style) would
 * hide the caret. Instead the SGR sequences written to stdout lose their
 * colour parameters and keep their style parameters.
 */

type Env = Record<string, string | undefined>;

export type ColourPolicy = "forced" | "none" | "auto";

export function colourPolicy(env: Env = process.env): ColourPolicy {
	if (env.FORCE_COLOR !== undefined) {
		const v = env.FORCE_COLOR;
		return v === "0" || v === "false" ? "none" : "forced";
	}
	if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
	if (env.TERM === "dumb") return "none";
	return "auto";
}

/** SGR parameters that set a colour: fg, bg, bright fg/bg, underline colour. */
function isColourParam(n: number): boolean {
	return (
		(n >= 30 && n <= 39) ||
		(n >= 40 && n <= 49) ||
		(n >= 90 && n <= 97) ||
		(n >= 100 && n <= 107) ||
		n === 58 ||
		n === 59
	);
}

// CSI ... m, parameters separated by ; (and : inside extended colours).
// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR needs the escape byte
const SGR = /\x1b\[([0-9;:]*)m/g;

/**
 * Remove colour from every SGR sequence in `s`, keeping bold, dim, italic,
 * underline, inverse, strikethrough and resets. A sequence left with no
 * parameters is dropped whole: an empty `ESC[m` means reset, not nothing.
 */
export function stripColourSgr(s: string): string {
	if (!s.includes("\x1b[")) return s;
	return s.replace(SGR, (whole, params: string) => {
		if (params === "") return whole;
		const tokens = params.split(";");
		const kept: string[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const tok = tokens[i];
			const head = Number.parseInt(tok.split(":")[0], 10);
			if (head === 38 || head === 48 || head === 58) {
				// Colon form carries its operands inside the token.
				if (tok.includes(":")) continue;
				// Semicolon form: 5;n or 2;r;g;b follow.
				const mode = tokens[i + 1];
				if (mode === "5") i += 2;
				else if (mode === "2") i += 4;
				continue;
			}
			if (Number.isNaN(head) || !isColourParam(head)) kept.push(tok);
		}
		return kept.length === 0 ? "" : `\x1b[${kept.join(";")}m`;
	});
}

type Writable = { write: (...args: never[]) => boolean };

/**
 * When the policy says "none", wrap `stream.write` so string output loses its
 * colour. Buffers pass through untouched (they may be binary). Returns true
 * when the wrap was installed.
 */
export function installColourPolicy(
	stream: Writable = process.stdout,
	env: Env = process.env,
): boolean {
	if (colourPolicy(env) !== "none") return false;
	const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
	(stream as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) =>
		write(typeof chunk === "string" ? stripColourSgr(chunk) : chunk, ...rest);
	return true;
}
