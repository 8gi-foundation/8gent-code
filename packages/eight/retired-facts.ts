/**
 * Retired-fact warning (#3811).
 *
 * A model asked to write from a notes file that says "X was replaced, do not use"
 * sometimes copies X into its output. This keeps, per turn, the dates and numbers that
 * files read this turn mark as retired and that no live line also carries, and names
 * them in one short line when a file written later contains one. It only warns: it
 * never blocks a write and never changes content.
 *
 * Retired means: a span between ~~ ~~, or a whole line that says superseded, obsolete,
 * deprecated, "do not use" or "replaced by". Live means any other text in any file read.
 * A token that is also live anywhere is not retired. A date compares on day and month alone
 * ("3 November 2026" retires "3 November", "November 3rd" and "3 Nov"). Bare numbers under three characters
 * are ignored: "3" and "10" are too common to mean anything on their own.
 */

const MONTH =
	"jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DAY = "\\d{1,2}(?:st|nd|rd|th)?";
// "3 November 2026", "3 Nov", "November 3, 2026", "2026-11-03", then plain numbers.
const DATE_OR_NUMBER = new RegExp(
	[
		`\\b${DAY}\\s{1,3}(?:${MONTH})\\b(?:,?\\s{1,3}\\d{4})?`,
		`\\b(?:${MONTH})\\s{1,3}${DAY}\\b(?:,?\\s{1,3}\\d{4})?`,
		"\\b\\d{4}-\\d{2}-\\d{2}\\b",
		"(?<!\\d)\\d+(?:[.:,]\\d+)+",
		"\\d{3,}",
	].join("|"),
	"gi",
);
const RETIRED_WORDS = /\b(superseded|obsolete|deprecated|do not use|replaced by)\b/i;
const STRUCK = /~~(.+?)~~/g;
const MAX_READ_CHARS = 200_000;
const MAX_LISTED = 5;
const MAX_TOKEN_CHARS = 40;
const MAX_ENTRIES = 5000;

/** A file name safe to print in a warning: basename only, word characters, dot, hyphen. */
export function safeLabel(file: string): string {
	return (file.split(/[\\/]/).pop() ?? "").replace(/[^\w.-]/g, "_").slice(0, 60) || "file";
}

interface Token {
	/** Comparison key: a date is "day mon" (year dropped), a number is itself. */
	key: string;
	/** The text as written, for the warning. */
	shown: string;
}

const MONTH_ABBR = new RegExp(`^(${MONTH})$`, "i");
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "3 November 2026", "November 3rd", "2026-11-03" all become "3 nov". Not a date: "". */
function dateKey(raw: string): string {
	const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (iso) return `${Number(iso[3])} ${MONTHS[Number(iso[2]) - 1] ?? ""}`;
	const day = raw.match(/\d{1,2}/)?.[0];
	const word = raw.match(/[a-z]+(?<!st|nd|rd|th)/gi)?.find((w) => MONTH_ABBR.test(w));
	if (!day || !word) return "";
	return `${Number(day)} ${word.slice(0, 3).toLowerCase()}`;
}

/** Dates (matched on day and month alone) and numbers in `text`. */
export function extractTokens(text: string): Token[] {
	const out: Token[] = [];
	for (const m of text.matchAll(DATE_OR_NUMBER)) {
		if (m[0].length > MAX_TOKEN_CHARS) continue;
		const shown = m[0].replace(/\s+/g, " ").trim();
		const key = /[a-z]/i.test(shown) || /^\d{4}-/.test(shown) ? dateKey(shown) : shown;
		if (key) out.push({ key, shown });
	}
	return out;
}

export class RetiredFacts {
	private retired = new Map<string, { shown: string; where: string }>(); // key -> token
	private live = new Set<string>();
	private readPaths = new Set<string>();

	private retire(t: Token, where: string): void {
		if (this.retired.size < MAX_ENTRIES && !this.retired.has(t.key))
			this.retired.set(t.key, { shown: t.shown, where });
	}

	/** A file was read this turn: sort its tokens into retired and live. */
	noteRead(file: string, content: string): void {
		this.readPaths.add(file);
		const label = safeLabel(file);
		const lines = content.slice(0, MAX_READ_CHARS).split("\n");
		lines.forEach((line, i) => {
			const where = `${label}:${i + 1}`;
			if (RETIRED_WORDS.test(line)) {
				for (const t of extractTokens(line)) this.retire(t, where);
				return;
			}
			for (const m of line.matchAll(STRUCK)) {
				for (const t of extractTokens(m[1])) this.retire(t, where);
			}
			for (const t of extractTokens(line.replace(STRUCK, " "))) {
				if (this.live.size < MAX_ENTRIES) this.live.add(t.key);
			}
		});
	}

	/** One short line naming retired tokens found in `content`, or "". Never throws. */
	warn(file: string, content: string): string {
		if (this.retired.size === 0 || this.readPaths.has(file)) return "";
		const found = new Set(extractTokens(content.slice(0, MAX_READ_CHARS)).map((t) => t.key));
		const hits: string[] = [];
		for (const [key, { shown, where }] of this.retired) {
			if (!this.live.has(key) && found.has(key)) hits.push(`"${shown}" (${where})`);
		}
		if (hits.length === 0) return "";
		const shown = hits.slice(0, MAX_LISTED).join(", ");
		return `[Retired fact] This file contains ${shown}, marked retired in a file you read. Remove it unless the reader needs it.`;
	}

	/** A new turn: forget everything read. */
	reset(): void {
		this.retired.clear();
		this.live.clear();
		this.readPaths.clear();
	}
}
