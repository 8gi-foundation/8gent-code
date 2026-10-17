/**
 * Placeholder-path lint (#4401).
 *
 * collab-support-unblock failed no_invented_paths twice: the task never says where Tally
 * lives, and the model wrote `cd C:\path\to\Tally` into UNBLOCK.md. After write_file or
 * edit_file on a prose doc (.md, .markdown, .txt), this names any invented folder
 * (`path/to`, `/your/project`, `<your-folder>/`, `Users/yourname`) in one line. A path the
 * task or a file read this turn already contains, in either slash style, is real and passes.
 * It only warns: it never blocks a write and never changes content.
 */

import { safeLabel } from "./retired-facts";

const ANGLE =
	"[<\\[{](?:(?:your|my)[-_ ]?[\\w-]{1,30}|user(?:name)?|project(?:[-_]?(?:name|folder|dir))?|folder|dir(?:ectory)?)[>\\]}]";
const PLACEHOLDER = new RegExp(
	[
		"(?<![\\w])path[\\\\/]to(?![\\w])",
		"[\\\\/](?:your|my)(?:[-_]?|[\\\\/])(?:project|folder|dir|directory|path|app)(?![\\w])",
		`(?<=[\\\\/])${ANGLE}`,
		`${ANGLE}(?=[\\\\/])`,
		"(?<=[\\\\/](?:users|home)[\\\\/])(?:yourname|your[-_]?user(?:name)?|username)(?![\\w])",
	].join("|"),
	"gi",
);
const PROSE = /\.(?:md|markdown|txt)$/i;
const PATH_CHAR = /[^\s"'`(),;]/;
const MAX_NAMED = 3;
const MAX_SHOWN = 60;
const MAX_SCAN = 200_000;

/** Lower case, one slash style: the form two spellings of one path share. */
const norm = (s: string) => s.toLowerCase().replace(/\\/g, "/");

/** The whole path-like word around a match, minus trailing sentence punctuation. */
function expand(text: string, at: number, len: number): string {
	let a = at;
	let b = at + len;
	while (a > 0 && PATH_CHAR.test(text[a - 1])) a--;
	while (b < text.length && PATH_CHAR.test(text[b])) b++;
	return text.slice(a, b).replace(/[.:!?]+$/, "");
}

/**
 * One line naming invented folders in `content`, or "". `inputs` is the text the task gave
 * (the request, files read this turn). Prose docs only. Never throws.
 */
export function placeholderPathLine(file: string, content: string, inputs: string[]): string {
	try {
		if (!PROSE.test(file)) return "";
		const text = content.slice(0, MAX_SCAN);
		const seen = new Set<string>();
		const found: string[] = [];
		for (const m of text.matchAll(PLACEHOLDER)) {
			const token = expand(text, m.index ?? 0, m[0].length);
			if (!token || seen.has(norm(token))) continue;
			seen.add(norm(token));
			found.push(token.length > MAX_SHOWN ? `${token.slice(0, MAX_SHOWN)}...` : token);
		}
		if (found.length === 0) return "";
		const given = inputs.map((t) => norm(t.slice(0, MAX_SCAN)));
		const invented = found.filter(
			(t) => !given.some((g) => g.includes(norm(t).replace(/\.\.\.$/, ""))),
		);
		if (invented.length === 0) return "";
		const named = invented.slice(0, MAX_NAMED).join(", ");
		return `[Placeholder path] ${named} in ${safeLabel(file)}: the task does not say where that folder is. Name the folder in words (the folder where the project is) or use a path relative to the project.`;
	} catch {
		return "";
	}
}
