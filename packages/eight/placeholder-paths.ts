/**
 * Placeholder-path lint (#4401).
 *
 * collab-support-unblock failed no_invented_paths twice: the task never says where Tally
 * lives, and the model wrote `cd C:\path\to\Tally` into UNBLOCK.md. After write_file or
 * edit_file on a prose doc (.md, .markdown, .txt), this names any invented folder
 * (`path/to`, `/your/project`, `<your-folder>/`, `Users/yourname`) in one line. A path the
 * task or a file read this turn already contains, in either slash style, is real and passes.
 *
 * #4405: a plausible invented path (`c:\users\priya\tally`) is no safer than `path\to`. In a
 * prose doc ANY absolute path (a drive path, `/Users/...`, `/home/...`, `~/...`) is invented
 * unless it, or a parent folder of it, appears in the task or a file read this turn
 * (case-insensitive, either slash style). This module only names the paths and never changes
 * content; the caller (ToolExecutor) refuses the write once per file per turn and then lets
 * the same file through.
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
const ABSOLUTE =
	/(?<![A-Za-z])[A-Za-z]:[\\/][^\s"'`(),;]+|(?<![\w.~/-])(?:\/(?:Users|home)\/|~\/)[^\s"'`(),;]+/gi;
/** A parent this short says nothing about where a project lives. */
const BARE_ROOT = new Set(["/users", "/home", "~", "c:/users", "c:/windows", "c:/program files"]);
const PROSE = /\.(?:md|markdown|txt)$/i;
const PATH_CHAR = /[^\s"'`(),;]/;
const MAX_NAMED = 3;
const MAX_SHOWN = 60;
const MAX_SCAN = 200_000;
const MAX_MATCHES = 50;
const MAX_SIDE = 200;

/** Lower case, one slash style: the form two spellings of one path share. */
const norm = (s: string) => s.toLowerCase().replace(/\\/g, "/");

/** The whole path-like word around a match, minus trailing sentence punctuation. */
function expand(text: string, at: number, len: number): string {
	let a = at;
	let b = at + len;
	while (a > 0 && at - a < MAX_SIDE && PATH_CHAR.test(text[a - 1])) a--;
	while (b < text.length && b - at - len < MAX_SIDE && PATH_CHAR.test(text[b])) b++;
	return text.slice(a, b).replace(/[.:!?]+$/, "");
}

/** True when `needle` sits in `hay` and the match ends at a path boundary (not mid-name). */
function containsPath(hay: string, needle: string): boolean {
	for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
		const next = hay[at + needle.length];
		if (next === undefined || !/[\w.-]/.test(next)) return true;
	}
	return false;
}

/** The path or one of its parent folders (never a bare root) appears in `given`. */
function isGiven(token: string, given: string[]): boolean {
	const t = norm(token).replace(/\/+$/, "");
	for (let end = t.length; end > 0; end = t.lastIndexOf("/", end - 1)) {
		const prefix = t.slice(0, end);
		if (prefix.endsWith(":") || BARE_ROOT.has(prefix)) break;
		if (given.some((g) => containsPath(g, prefix))) return true;
	}
	return false;
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
		let matches = 0;
		for (const m of text.matchAll(PLACEHOLDER)) {
			if (++matches > MAX_MATCHES) break;
			const token = expand(text, m.index ?? 0, m[0].length);
			// A URL is a real address, not a folder the model made up.
			if (!token || token.includes("://") || seen.has(norm(token))) continue;
			seen.add(norm(token));
			found.push(token.length > MAX_SHOWN ? `${token.slice(0, MAX_SHOWN)}...` : token);
		}
		const given = inputs.map((t) => norm(t.slice(0, MAX_SCAN)));
		const invented = found.filter(
			(t) => !given.some((g) => g.includes(norm(t).replace(/\.\.\.$/, ""))),
		);
		for (const m of text.matchAll(ABSOLUTE)) {
			if (++matches > MAX_MATCHES * 2) break;
			const token = expand(text, m.index ?? 0, m[0].length);
			if (!token || token.includes("://") || seen.has(norm(token))) continue;
			seen.add(norm(token));
			if (isGiven(token, given)) continue;
			invented.push(token.length > MAX_SHOWN ? `${token.slice(0, MAX_SHOWN)}...` : token);
		}
		if (invented.length === 0) return "";
		const named = invented.slice(0, MAX_NAMED).join(", ");
		return `[Placeholder path] ${named} in ${safeLabel(file)}: the task does not say where that folder is. In commands, do not put a made-up or described folder inside the path; tell the reader to open or cd into the project folder first, then use the path relative to it (for example \`node src/app.js\`).`;
	} catch {
		return "";
	}
}
