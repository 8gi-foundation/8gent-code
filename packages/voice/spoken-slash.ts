/**
 * Spoken "slash" types "/" (#4949), so a slash command can be voice typed:
 * "slash dj play lofi" becomes "/dj play lofi".
 *
 * One pure function, applied where both voice paths (local whisper and the Termux paths)
 * hand the transcript to the input. Rules, in order:
 *  - "slash" (any case) becomes "/" only when the word right after it is a known command, at the
 *    start of the transcript or after a sentence end. The space after it and any comma or full
 *    stop the transcriber put there are dropped. "Slash prices by ten percent" is prose, and so
 *    is "slashing" or "slashdot". A lone "slash" at the start types a lone "/" (opens the menu).
 *  - One-letter names never count as known ("Slash c is fine" must not run /c), whatever the
 *    caller passes.
 *  - Anywhere else "slash" is a word: "cut and slash prices" is never rewritten.
 *  - A known command name is lowercased ("DJ" to "dj"), and the full stop the transcriber puts
 *    after a recognised command line is dropped. Arguments are never touched.
 */

const START = /^(\s*)slash(?![A-Za-z0-9])[\s,.!?;:]*/i;
const MID = /([.!?]["')\]]?\s+)slash(?![A-Za-z0-9])[\s,.!?;:]*(?=\S)/i;
const TAIL_PUNCT = /[\s.,!?;:]+$/;
const WORD = /^\S+/;

const wordName = (w: string) => w.replace(/[.,!?;:]+$/, "").toLowerCase();

const isKnown = (w: string, known: ReadonlySet<string>) => {
	const n = wordName(w);
	return n.length > 1 && known.has(n);
};

/** The text after "/": lowercase the known first word, drop a trailing full stop of the line. */
function commandLine(rest: string, first: string): string {
	return `${wordName(first)}${rest.slice(first.length)}`.replace(TAIL_PUNCT, "");
}

export function spokenSlash(text: string, known: ReadonlySet<string> = new Set()): string {
	const start = START.exec(text);
	if (start) {
		const rest = text.slice(start[0].length);
		const first = WORD.exec(rest)?.[0];
		if (!first) return rest.trim() === "" ? "/" : text;
		return isKnown(first, known) ? `/${commandLine(rest, first)}` : text;
	}
	const mid = MID.exec(text);
	if (mid) {
		const rest = text.slice(mid.index + mid[0].length);
		const first = WORD.exec(rest)?.[0];
		if (first && isKnown(first, known)) {
			return `${text.slice(0, mid.index)}${mid[1]}/${commandLine(rest, first)}`;
		}
	}
	return text;
}
