/**
 * The always-blocked check (#3768): which commands a line runs, and whether
 * any of them is a catastrophic one. Matching is on exact targets, so
 * ordinary work (a recursive delete of a build directory, a recursive
 * ownership change in the project) is never caught.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findPayloads, stripPrefix } from "./command-policy";
import { tokenize } from "./src/workspace-boundary";

const MAX_DEPTH = 6;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "csh", "tcsh"]);

/** Wrappers whose own options this check does not follow: every word after them counts. */
const OPAQUE_WRAPPERS = new Set([
	"busybox",
	"doas",
	"su",
	"ssh",
	"parallel",
	"watch",
	"setsid",
	"flock",
	"chroot",
	"runuser",
	"unshare",
	"nsenter",
	"script",
]);

/** Shell grammar words that precede a command without being one. */
const GRAMMAR = new Set([
	"{",
	"}",
	"!",
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"do",
	"done",
	"while",
	"until",
]);

const SYSTEM_DIRS = [
	"/",
	"/etc",
	"/usr",
	"/bin",
	"/sbin",
	"/lib",
	"/lib64",
	"/boot",
	"/var",
	"/system",
	"/library",
	"/private/etc",
	"/private/var",
];

const DISK_DEVICE = /^\/dev\/(sd|hd|vd|xvd|nvme|disk|rdisk|mmcblk)/i;

/** Collapse `//`, `/.`, `/x/..`; drop a trailing slash. Relative paths pass through. */
function normTarget(operand: string): string {
	if (!operand.startsWith("/")) return operand;
	let p = path.posix.normalize(operand);
	if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
	return p;
}

function splitArgs(args: string[]): { flags: string[]; operands: string[] } {
	const flags: string[] = [];
	const operands: string[] = [];
	let afterDashes = false;
	for (const a of args) {
		if (!afterDashes && a === "--") {
			afterDashes = true;
			continue;
		}
		if (!afterDashes && a.length > 1 && a.startsWith("-")) flags.push(a);
		else operands.push(a);
	}
	return { flags, operands };
}

function isRecursive(flags: string[]): boolean {
	return flags.some((f) =>
		f.startsWith("--") ? f === "--recursive" : /^-[A-Za-z]*[rR][A-Za-z]*$/.test(f),
	);
}

function isRootTarget(t: string): boolean {
	return t === "/" || t === "/*";
}

/** The person's home directory, as the shell may spell it: literal path and its realpath. */
function homePaths(): string[] {
	const out = new Set<string>();
	let home = "";
	try {
		home = os.homedir();
	} catch {
		return [];
	}
	if (!home || home === "/") return [];
	out.add(path.posix.normalize(home).replace(/\/+$/, ""));
	try {
		out.add(fs.realpathSync(home).replace(/\/+$/, ""));
	} catch {
		// an unreadable home still has its literal spelling
	}
	out.delete("");
	return [...out];
}

/** APFS and NTFS compare paths without case, so `/users/me` is the same directory as `/Users/me`. */
const FOLD_CASE = process.platform === "darwin" || process.platform === "win32";
const fold = (s: string): string => (FOLD_CASE ? s.toLowerCase() : s);

/** Stands in for whatever spelling of the home directory the shell was given. */
const HOME_TOKEN = "/__H__";

/** `~name` for the signed-in user only. `~root`, `~+`, `~-` and other users are not home. */
function isTildeSelf(s: string): boolean {
	if (!s.startsWith("~") || s.length < 2) return false;
	try {
		return fold(s.slice(1)) === fold(os.userInfo().username);
	} catch {
		return false;
	}
}

/**
 * If `t` starts with a spelling of the home directory (`~`, `~user`, `$HOME`, `${HOME<anything>}`
 * with nesting, or the expanded path in any case the filesystem folds), return what follows it,
 * which is "" or starts with `/`. Otherwise null.
 */
function afterHome(t: string): string | null {
	const end = (r: string): string | null => (r === "" || r.startsWith("/") ? r : null);
	if (t.startsWith("~")) {
		const m = /^~[^/]*/.exec(t) as RegExpExecArray;
		return m[0] === "~" || isTildeSelf(m[0]) ? end(t.slice(m[0].length)) : null;
	}
	if (/^\$HOME(?![A-Za-z0-9_])/.test(t)) return end(t.slice(5));
	if (/^\$\{HOME(?![A-Za-z0-9_])/.test(t)) {
		let depth = 0;
		for (let i = 1; i < t.length; i++) {
			if (t[i] === "{") depth++;
			else if (t[i] === "}" && --depth === 0) return end(t.slice(i + 1));
		}
		return null;
	}
	if (t.startsWith("/")) {
		const n = normTarget(t);
		for (const h of homePaths()) {
			if (fold(n).startsWith(fold(h))) {
				const r = end(n.slice(h.length));
				if (r !== null) return r;
			}
		}
	}
	return null;
}

/**
 * The whole home directory (#4485): `~`, `~user`, `$HOME`, `${HOME}` and any expansion form, the
 * expanded path in any case the filesystem folds, with trailing slashes, `.` and `..` segments
 * resolved, and an optional `/*` or `/.*`. Also the dotfile wipe idiom, a glob directly under home
 * that starts with `.` (`~/.??*`, `$HOME/.[!.]*`), and a bare `*` directly under home even when more
 * path follows (`$HOME/*` + `/*` empties every folder in home). A folder inside home is not a home target.
 */
function isHomeTarget(t: string): boolean {
	const all = expandBraces(t);
	// Too many alternatives to enumerate is itself a reason to refuse: nobody types that by hand.
	return all === null || all.some(isHomeTargetOne);
}

const MAX_BRACE_EXPANSIONS = 512;

/**
 * Shell brace expansion, every alternative (`~/{*,.*}` -> `~/*`, `~/.*`; `{~,/x}/*` -> `~/*`, `/x/*`).
 * A `{` right after `$` is a parameter expansion, not a brace, and a brace with no top-level comma
 * stays literal. Returns null when the result would pass MAX_BRACE_EXPANSIONS.
 */
function expandBraces(s: string): string[] | null {
	let out = [s];
	for (let guard = 0; guard < 64; guard++) {
		let changed = false;
		const next: string[] = [];
		for (const str of out) {
			const parts = expandFirstBrace(str);
			if (parts) changed = true;
			next.push(...(parts ?? [str]));
			if (next.length > MAX_BRACE_EXPANSIONS) return null;
		}
		out = next;
		if (!changed) return out;
	}
	return null;
}

function expandFirstBrace(s: string): string[] | null {
	for (let i = 0; i < s.length; i++) {
		if (s[i] !== "{" || s[i - 1] === "$") continue;
		let depth = 0;
		const cuts: number[] = [];
		for (let j = i; j < s.length; j++) {
			if (s[j] === "{") depth++;
			else if (s[j] === "}" && --depth === 0) {
				if (cuts.length === 0) break;
				const head = s.slice(0, i);
				const tail = s.slice(j + 1);
				const bounds = [i, ...cuts, j];
				const alts: string[] = [];
				for (let k = 0; k < bounds.length - 1; k++)
					alts.push(head + s.slice(bounds[k] + 1, bounds[k + 1]) + tail);
				return alts;
			} else if (s[j] === "," && depth === 1) cuts.push(j);
		}
	}
	return null;
}

const GLOB_ATOM = "(?:[*?]|\\[[!^]?\\]?(?:\\[[:.=][^\\]]*[:.=]\\]|[^\\]])*\\])";

/** Inner text of a balanced `(...)` starting at s[i] === "(", and the index after it; null if unbalanced. */
function parenGroup(s: string, i: number): { inner: string; next: number } | null {
	let depth = 0;
	for (let j = i; j < s.length; j++) {
		if (s[j] === "(") depth++;
		else if (s[j] === ")" && --depth === 0) return { inner: s.slice(i + 1, j), next: j + 1 };
	}
	return null;
}

/**
 * One path component that can match every entry: only glob atoms (`*`, `?`, bracket classes with
 * POSIX classes inside), extglobs that can match anything (`!(x)`, `@(*)`, `+(*)`, `*(*)`, `?(*)`),
 * and a trailing zsh qualifier (`*(D)`, `*(N)`, `*(.)`) on an otherwise wild component.
 */
function isWildComponent(c: string): boolean {
	let i = 0;
	let atoms = 0;
	while (i < c.length) {
		const rest = c.slice(i);
		const m = new RegExp(`^${GLOB_ATOM}`).exec(rest);
		if (m) {
			i += m[0].length;
			atoms++;
			continue;
		}
		if (/^[@+!]\(/.test(rest)) {
			const g = parenGroup(c, i + 1);
			if (!g) return false;
			const anyWild = c[i] === "!" || g.inner.split("|").some((a) => isWildComponent(a));
			if (!anyWild) return false;
			i = g.next;
			atoms++;
			continue;
		}
		if (c[i] === "(" && atoms > 0) {
			// a zsh glob qualifier (or an extglob lead after a star): matches by attribute, not by name
			const g = parenGroup(c, i);
			if (!g) return false;
			i = g.next;
			continue;
		}
		return false;
	}
	return atoms > 0;
}

function isHomeTargetOne(t: string): boolean {
	t = t.replace(/\/+$/, "");
	if (isHomeAncestor(t)) return true;
	const rest = afterHome(t);
	if (rest === null) return false;
	const p = path.posix.normalize(HOME_TOKEN + rest).replace(/\/+$/, "");
	if (p === "" || p === HOME_TOKEN) return true;
	// Not under home any more: `..` climbed out (`~/../*`, `$HOME/../jamesspalding`), so the delete
	// resolves at or above home. That is a wipe.
	if (!p.startsWith(`${HOME_TOKEN}/`)) return true;
	const parts = p.slice(HOME_TOKEN.length + 1).split("/");
	// Every component after home is made only of glob metacharacters (`*`, `?`, `**`, bracket
	// classes like `[!.]`) or is a dot-glob (`$HOME/*`, `~/*/?*`, `~/[!.]*`, `~/*/.*`, `~/.??*`).
	// `~/*/node_modules`, `~/*.log` and `~/*/x*` name something specific, so they only ask.
	const wild = (c: string) => isWildComponent(c) || (c.startsWith(".") && /[*?[]|[@+!]\(/.test(c));
	return parts.every(wild);
}

/** The parent of home (`/Users`, `/home`) or its direct children glob (`/Users/*`): every account. */
function isHomeAncestor(t: string): boolean {
	const n = fold(normTarget(t)).replace(/\/+$/, "");
	for (const h of homePaths()) {
		const parent = fold(path.posix.dirname(h));
		if (parent === "/" || parent === ".") continue;
		if (n === parent || n === `${parent}/*`) return true;
	}
	return false;
}

function isSystemTarget(t: string): boolean {
	const lower = t.toLowerCase();
	return (
		SYSTEM_DIRS.some((d) => lower === d || lower === `${d}/*` || lower === `${d}*`) ||
		isRootTarget(t)
	);
}

/** Why this one command is always refused, or null. Exact targets only. */
export function blockedReason(argv: string[]): string | null {
	if (argv.length === 0) return null;
	const name = path.basename(argv[0]).toLowerCase();
	const { flags, operands } = splitArgs(argv.slice(1));
	const targets = operands.map(normTarget);

	if (name === "rm") {
		if (isRecursive(flags) && targets.some(isRootTarget))
			return "recursive delete of the root filesystem";
		if (isRecursive(flags) && targets.some(isHomeTarget))
			return "recursive delete of the home directory";
		return null;
	}
	if (name === "chmod") {
		const mode = operands[0];
		if (targets.slice(1).some(isRootTarget) && (isRecursive(flags) || mode === "000")) {
			return "permission change on the root filesystem";
		}
		return null;
	}
	if (name === "chown" || name === "chgrp") {
		if (isRecursive(flags) && targets.slice(1).some(isSystemTarget)) {
			return "recursive ownership change on the root or a system directory";
		}
		return null;
	}
	if (name === "dd") {
		for (const a of argv.slice(1)) {
			if (a.toLowerCase().startsWith("of=") && DISK_DEVICE.test(a.slice(3))) {
				return "overwrite of a disk device";
			}
		}
		return null;
	}
	if (/^mkfs(\.|$)/.test(name) || name === "newfs") {
		if (operands.some((o) => DISK_DEVICE.test(o))) return "format of a disk device";
		return null;
	}
	return null;
}

/** Every suffix of the words: no command can hide behind a wrapper this check cannot read. */
function emitLoose(tokens: string[], out: string[][], depth: number): void {
	for (let i = 0; i < tokens.length; i++) out.push(tokens.slice(i));
	for (const t of tokens) if (/\s/.test(t)) scanLine(t, out, depth + 1);
}

function processSegment(
	rawTokens: string[],
	prevTokens: string[] | null,
	out: string[][],
	depth: number,
): void {
	let tokens = rawTokens;
	while (tokens.length > 0 && GRAMMAR.has(tokens[0])) tokens = tokens.slice(1);
	if (tokens.length === 0) return;
	if (depth > MAX_DEPTH) {
		emitLoose(tokens, out, depth);
		return;
	}
	const unwrapped = stripPrefix(tokens);
	if (!unwrapped) {
		emitLoose(tokens, out, depth);
		return;
	}
	const argv = unwrapped.argv;
	if (argv.length === 0) return;
	out.push(argv);
	const name = path.basename(argv[0]);

	if (OPAQUE_WRAPPERS.has(name)) emitLoose(argv.slice(1), out, depth);
	if (name === "eval") scanLine(argv.slice(1).join(" "), out, depth + 1);
	if (SHELLS.has(name)) {
		for (const t of argv.slice(1)) if (/\s/.test(t)) scanLine(t, out, depth + 1);
		// A shell reading a pipe runs whatever the earlier command printed.
		if (prevTokens && !argv.slice(1).some((a) => /^-[A-Za-z]*c/.test(a))) {
			emitLoose(prevTokens, out, depth);
		}
	}
	for (const payload of findPayloads(argv)) {
		if (payload.length > 0) scanLine(payload.join(" "), out, depth + 1);
	}
}

/** The index just past the `)` that closes a `(` already consumed, honouring nesting. */
function closeParen(text: string, from: number): number {
	let level = 1;
	for (let i = from; i < text.length; i++) {
		if (text[i] === "\\") i++;
		else if (text[i] === "(") level++;
		else if (text[i] === ")" && --level === 0) return i;
	}
	return text.length;
}

function scanLine(input: string, out: string[][], depth: number): void {
	// A backslash-newline continues the line; a redirect operator is not a separator.
	const text = input
		.replace(/\\\r?\n/g, "")
		.replace(/\d*>&\d+/g, " ")
		.replace(/&>/g, ">");

	const segments: Array<{ tokens: string[]; piped: boolean }> = [];
	let cur = "";
	let piped = false;
	const flush = (nextPiped: boolean) => {
		if (cur.trim()) segments.push({ tokens: tokenize(cur), piped });
		cur = "";
		piped = nextPiped;
	};

	let inSingle = false;
	let inDouble = false;
	let globEnd = -2;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (ch === "\\" && !inSingle) {
			cur += ch + (next ?? "");
			i++;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			cur += ch;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			cur += ch;
			continue;
		}
		if (inSingle) {
			cur += ch;
			continue;
		}
		// Substitutions run inside double quotes too.
		if ((ch === "$" || (!inDouble && (ch === "<" || ch === ">"))) && next === "(") {
			const end = closeParen(text, i + 2);
			if (depth < MAX_DEPTH) scanLine(text.slice(i + 2, end), out, depth + 1);
			else emitLoose(tokenize(text.slice(i + 2, end)), out, depth);
			cur += " X ";
			i = end;
			continue;
		}
		if (ch === "`") {
			let end = i + 1;
			while (end < text.length && text[end] !== "`") end += text[end] === "\\" ? 2 : 1;
			if (depth < MAX_DEPTH) scanLine(text.slice(i + 1, end), out, depth + 1);
			else emitLoose(tokenize(text.slice(i + 1, end)), out, depth);
			cur += " X ";
			i = end;
			continue;
		}
		if (inDouble) {
			cur += ch;
			continue;
		}
		// `(` glued to a glob character is an extglob or zsh qualifier (`~/@(*)`, `~/*(D)`), part of
		// the word and not a subshell. Its inside is still scanned as a line, so nothing hides in it.
		if (ch === "(" && i > 0 && (/[*?+@!]/.test(text[i - 1]) || i - 1 === globEnd)) {
			const end = closeParen(text, i + 1);
			const inner = text.slice(i + 1, end);
			if (depth < MAX_DEPTH) scanLine(inner, out, depth + 1);
			else emitLoose(tokenize(inner), out, depth);
			cur += text.slice(i, end + 1);
			globEnd = end;
			i = end;
			continue;
		}
		if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
			flush(false);
			i++;
		} else if (ch === "|") {
			if (next === "&") i++;
			flush(true);
		} else if (ch === ";" || ch === "&" || ch === "\n" || ch === "\r" || ch === "(" || ch === ")") {
			flush(false);
		} else {
			cur += ch;
		}
	}
	flush(false);

	for (let s = 0; s < segments.length; s++) {
		const prev = segments[s].piped && s > 0 ? segments[s - 1].tokens : null;
		processSegment(segments[s].tokens, prev, out, depth);
	}
}

/**
 * Every command a line runs, as argv: each segment with its prefixes and
 * wrappers removed, plus the commands inside command substitutions, subshells,
 * groups, loop and condition bodies, quoted shell words, text piped into a
 * shell, and `find -exec` payloads. A wrapper or construct that cannot be
 * read yields every suffix of its words, so nothing hides behind it.
 */
export function commandArgvs(command: string): string[][] {
	const out: string[][] = [];
	scanLine(command, out, 0);
	return out;
}
