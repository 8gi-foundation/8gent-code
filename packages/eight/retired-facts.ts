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
 * A token that is also live anywhere is not retired. Bare numbers under three characters
 * are ignored: "3" and "10" are too common to mean anything on their own.
 */

const MONTH =
	"jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DAY = "\\d{1,2}(?:st|nd|rd|th)?";
// "3 November 2026", "3 Nov", "November 3, 2026", "2026-11-03", then plain numbers.
const DATE_OR_NUMBER = new RegExp(
	[
		`\\b${DAY}\\s+(?:${MONTH})\\b(?:,?\\s+\\d{4})?`,
		`\\b(?:${MONTH})\\s+${DAY}\\b(?:,?\\s+\\d{4})?`,
		"\\b\\d{4}-\\d{2}-\\d{2}\\b",
		"\\d+(?:[.:,]\\d+)+",
		"\\d{3,}",
	].join("|"),
	"gi",
);
const RETIRED_WORDS = /\b(superseded|obsolete|deprecated|do not use|replaced by)\b/i;
const STRUCK = /~~(.+?)~~/g;
const MAX_READ_CHARS = 200_000;
const MAX_LISTED = 5;

/** Dates and numbers in `text`, lowercased, ordinals dropped, spaces collapsed. */
export function extractTokens(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(DATE_OR_NUMBER)) {
		out.push(
			m[0]
				.toLowerCase()
				.replace(/(\d)(?:st|nd|rd|th)\b/g, "$1")
				.replace(/\s+/g, " ")
				.trim(),
		);
	}
	return out;
}

function hasToken(haystack: string, token: string): boolean {
	const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![\\w])${esc}(?![\\w])`, "i").test(
		haystack.replace(/(\d)(?:st|nd|rd|th)\b/gi, "$1").replace(/\s+/g, " "),
	);
}

export class RetiredFacts {
	private retired = new Map<string, string>(); // token -> "file:line"
	private live = new Set<string>();
	private readPaths = new Set<string>();

	/** A file was read this turn: sort its tokens into retired and live. */
	noteRead(file: string, content: string): void {
		this.readPaths.add(file);
		const lines = content.slice(0, MAX_READ_CHARS).split("\n");
		lines.forEach((line, i) => {
			const where = `${file}:${i + 1}`;
			if (RETIRED_WORDS.test(line)) {
				for (const t of extractTokens(line)) if (!this.retired.has(t)) this.retired.set(t, where);
				return;
			}
			for (const m of line.matchAll(STRUCK)) {
				for (const t of extractTokens(m[1])) if (!this.retired.has(t)) this.retired.set(t, where);
			}
			for (const t of extractTokens(line.replace(STRUCK, " "))) this.live.add(t);
		});
	}

	/** One short line naming retired tokens found in `content`, or "". Never throws. */
	warn(file: string, content: string): string {
		if (this.retired.size === 0 || this.readPaths.has(file)) return "";
		const hits: string[] = [];
		for (const [token, where] of this.retired) {
			if (this.live.has(token)) continue;
			if (hasToken(content, token)) hits.push(`"${token}" (${where})`);
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
