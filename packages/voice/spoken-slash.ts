/**
 * Spoken "slash" types "/" (#4949), so a slash command can be voice typed:
 * "slash dj play lofi" becomes "/dj play lofi".
 *
 * One pure function, applied where both voice paths (local whisper and the Termux paths)
 * hand the transcript to the input. Rules, in order:
 *  - "slash" (any case) at the start of the transcript becomes "/"; the space after it and any
 *    comma or full stop the transcriber put there are dropped. "slashing" and "slashdot" are
 *    not "slash".
 *  - Later, "slash" after a sentence end opens a new command only when the next word is a known
 *    command, so "I disagree. Slash prices by ten percent" stays prose.
 *  - Anywhere else "slash" is a word: "cut and slash prices" is never rewritten.
 *  - A known command name is lowercased ("DJ" to "dj"), and the full stop the transcriber puts
 *    after a recognised command line is dropped. Arguments are never touched.
 */

const START = /^(\s*)slash(?![A-Za-z0-9])[\s,.!?;:]*/i;
const MID = /([.!?]["')\]]?\s+)slash(?![A-Za-z0-9])[\s,.!?;:]*(?=\S)/i;
const TAIL_PUNCT = /[\s.,!?;:]+$/;
const WORD = /^\S+/;

const wordName = (w: string) => w.replace(/[.,!?;:]+$/, "").toLowerCase();

/** The text after "/": lowercase a known first word, and drop a trailing full stop of a known line. */
function commandLine(rest: string, known: ReadonlySet<string>): string {
	const first = WORD.exec(rest)?.[0];
	if (!first) return rest;
	const name = wordName(first);
	if (!known.has(name)) return rest;
	return `${name}${rest.slice(first.length)}`.replace(TAIL_PUNCT, "");
}

export function spokenSlash(text: string, known: ReadonlySet<string> = new Set()): string {
	const start = START.exec(text);
	if (start) return `/${commandLine(text.slice(start[0].length), known)}`;
	const mid = MID.exec(text);
	if (mid) {
		const rest = text.slice(mid.index + mid[0].length);
		const first = WORD.exec(rest)?.[0];
		if (first && known.has(wordName(first))) {
			return `${text.slice(0, mid.index)}${mid[1]}/${commandLine(rest, known)}`;
		}
	}
	return text;
}
