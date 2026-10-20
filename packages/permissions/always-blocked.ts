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
	return t === "/" || t === "/*" || globIsRoot(t);
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
function expandBraces(s: string, cap = MAX_BRACE_EXPANSIONS): string[] | null {
	let out = [s];
	for (let guard = 0; guard < 64; guard++) {
		let changed = false;
		const next: string[] = [];
		for (const str of out) {
			const parts = expandFirstBrace(str);
			if (parts === WIDE) return null;
			if (parts) changed = true;
			next.push(...(parts ?? [str]));
			if (next.length > cap) return null;
		}
		out = next;
		if (!changed) return out;
	}
	return null;
}

/**
 * `{x..y}` with one character at each end (zsh expands `{/..0}` to `/` and `0`; bash 3.2 leaves it
 * literal, and refusing the literal is the safe side). A span of 64 or more is too wide to enumerate: the word takes the overflow refusal. Multi-digit
 * number sequences are left alone: they cannot spell a wipe target.
 */
function charSequence(body: string): string[] | "wide" | null {
	const m = /^([^.])\.\.([^.])$/u.exec(body);
	if (!m) return null;
	const a = m[1].codePointAt(0) as number;
	const b = m[2].codePointAt(0) as number;
	if (Math.abs(a - b) >= MAX_WORD_BRACES) return "wide";
	const out: string[] = [];
	for (let c = a; a <= b ? c <= b : c >= b; c += a <= b ? 1 : -1) out.push(String.fromCodePoint(c));
	return out;
}

/** expandFirstBrace result for a character range too wide to enumerate: the word takes the overflow refusal. */
const WIDE: string[] = [];

function expandFirstBrace(s: string): string[] | null {
	for (let i = 0; i < s.length; i++) {
		if (s[i] !== "{" || s[i - 1] === "$") continue;
		let depth = 0;
		const cuts: number[] = [];
		for (let j = i; j < s.length; j++) {
			if (s[j] === "{") depth++;
			else if (s[j] === "}" && --depth === 0) {
				if (cuts.length === 0) {
					const seq = charSequence(s.slice(i + 1, j));
					if (!seq) break;
					if (seq === "wide") return WIDE;
					return seq.map((c) => s.slice(0, i) + c + s.slice(j + 1));
				}
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

/** What a POSIX class inside a bracket stands for in a RegExp class. `punct` and `print` hold `/`. */
const POSIX_CLASS: Record<string, string> = {
	alpha: "A-Za-z",
	digit: "0-9",
	alnum: "A-Za-z0-9",
	upper: "A-Z",
	lower: "a-z",
	space: "\\s",
	blank: " \\t",
	xdigit: "0-9A-Fa-f",
	punct: "\\x21-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7e",
	print: "\\x20-\\x7e",
	graph: "\\x21-\\x7e",
	cntrl: "\\x00-\\x1f\\x7f",
};

interface Bracket {
	/** Index just past the closing `]`. */
	end: number;
	negated: boolean;
	/** The characters it lists, ranges and POSIX classes spelled out as a RegExp class body. */
	body: string;
	/** Explicit single characters, or null when a range is too wide to list or a POSIX class is present. */
	members: string[] | null;
	/** `body` without the POSIX classes: the part that can be case-folded. */
	lit: string;
	/** The POSIX class part of `body`. */
	cls: string;
	/** A POSIX class is present: matched as a pattern, never listed. */
	hasClass: boolean;
	/** Lists only digits, which can never spell a name, a flag or a slash. */
	digitsOnly: boolean;
}

/** The bracket expression starting at s[i] === "[", or null when it never closes (then `[` is literal). */
function parseBracket(s: string, i: number): Bracket | null {
	let j = i + 1;
	const negated = s[j] === "!" || s[j] === "^";
	if (negated) j++;
	let body = "";
	let lit = "";
	let cls = "";
	let members: string[] | null = [];
	let hasClass = false;
	let digitsOnly = true;
	const esc = (c: string) => c.replace(/[\\\]^\-[]/g, "\\$&");
	for (let first = true; ; first = false) {
		const c = s[j];
		if (c === undefined) return null;
		if (c === "]" && !first) break;
		if (c === "[" && ":.=".includes(s[j + 1] ?? "") && s.indexOf(`${s[j + 1]}]`, j + 2) > 0) {
			const close = s.indexOf(`${s[j + 1]}]`, j + 2);
			const named = s[j + 1] === ":" ? (POSIX_CLASS[s.slice(j + 2, close)] ?? "\\x20-\\x7e") : "";
			body += named;
			cls += named;
			members = null;
			hasClass = true;
			digitsOnly = false;
			j = close + 2;
			continue;
		}
		let lo = c;
		if (c === "\\" && s[j + 1] !== undefined) lo = s[++j];
		let hi = lo;
		if (s[j + 1] === "-" && s[j + 2] !== undefined && s[j + 2] !== "]") {
			hi = s[j + 2];
			j += 2;
		}
		j++;
		const a = lo.codePointAt(0) as number;
		const b = hi.codePointAt(0) as number;
		if (a > b) continue;
		const piece = `${esc(lo)}${a === b ? "" : `-${esc(hi)}`}`;
		body += piece;
		lit += piece;
		if (!(a >= 48 && b <= 57)) digitsOnly = false;
		if (members) {
			if (b - a >= MAX_WORD_BRACES) members = null;
			else for (let k = a; k <= b; k++) members.push(String.fromCodePoint(k));
		}
	}
	return { end: j + 1, negated, body, lit, cls, members, hasClass, digitsOnly };
}

/**
 * Every spelling of a word with its positive bracket expressions replaced by each listed member
 * (`/[U]sers` -> `/Users`, `[r]m` -> `r`+`m`, `-[r]f` -> `-rf`, `[/]` -> `/`). Negated brackets, POSIX
 * classes and digit-only brackets stay literal here: the path checks match them as patterns instead.
 * Returns null when a range is too wide or the result would pass `cap`: the word takes the overflow refusal.
 */
function expandBrackets(s: string, cap = MAX_WORD_BRACES): string[] | null {
	for (let i = 0; i < s.length; i++) {
		if (s[i] !== "[") continue;
		const b = parseBracket(s, i);
		if (!b) continue;
		if (b.negated || b.digitsOnly || b.hasClass) {
			i = b.end - 1;
			continue;
		}
		if (b.members === null) return null; // a range too wide to list
		const rest = expandBrackets(s.slice(b.end), cap);
		if (rest === null || rest.length * b.members.length > cap) return null;
		const head = s.slice(0, i);
		return b.members.flatMap((m) => rest.map((r) => head + m + r));
	}
	return [s];
}

/** Brace expansion and then bracket expansion of one word; null when either is too wide. */
function expandWord(t: string, cap = MAX_WORD_BRACES): string[] | null {
	const braced = t.includes("{") ? expandBraces(t, cap) : [t];
	if (braced === null || !t.includes("[")) return braced;
	const out: string[] = [];
	for (const b of braced) {
		const r = expandBrackets(b, cap);
		if (r === null) return null;
		out.push(...r);
		if (out.length > cap) return null;
	}
	return out;
}

/**
 * A shell glob as a RegExp over a whole path: `*` and `?` stay inside one component, a bracket matches
 * what it lists (a negated one never matches `/`; a positive one matches `/` if it lists it). Null when
 * the word has no glob character. Used to ask whether a pattern could name the home directory or the root.
 */
function fold1(c: string): string {
	const e = c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
	const other = c.toLowerCase() === c ? c.toUpperCase() : c.toLowerCase();
	return FOLD_CASE && other !== c && other.length === 1 ? `[${c}${other}]` : e;
}

/**
 * A positive bracket on a case-folding filesystem lists both cases of its letters. A negated one is
 * never folded: the shell compares it case-sensitively with the real name, so `[^A-Z]` matches `j`.
 */
function foldBody(b: Bracket): string {
	if (!FOLD_CASE) return b.body;
	try {
		new RegExp(`[${b.lit}${b.lit.toUpperCase()}${b.lit.toLowerCase()}]`);
		return b.lit + b.lit.toUpperCase() + b.lit.toLowerCase() + b.cls;
	} catch {
		return b.body;
	}
}

function globRegExp(pattern: string): RegExp | null {
	let re = "";
	let wild = false;
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "\\" && i + 1 < pattern.length) {
			re += fold1(pattern[++i]);
		} else if (c === "*" || c === "?") {
			wild = true;
			re += c === "*" ? "[^/]*" : "[^/]";
		} else if (c === "[") {
			const b = parseBracket(pattern, i);
			if (!b) {
				re += "\\[";
				continue;
			}
			wild = true;
			re += b.negated ? `[^/${b.body}]` : `[${foldBody(b)}]`;
			i = b.end - 1;
		} else re += fold1(c);
	}
	return wild ? new RegExp(`^${re}$`) : null;
}

/** True when the glob `pattern` can match the home directory, the directory above it, or the root. */
function globHitsHome(pattern: string): boolean {
	const re = globRegExp(pattern.replace(/\/{2,}/g, "/"));
	if (!re) return false;
	return homePaths().some((h) => re.test(h) || re.test(path.posix.dirname(h)));
}

/** True when a bracket in `t` can match `/` and the whole word then names the root (`[/]`, `[+-0]`, `/[/]`). */
function globIsRoot(t: string): boolean {
	if (!t.includes("[")) return false;
	const re = globRegExp(t);
	return re !== null && ["/", "//", "///"].some((r) => re.test(r));
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
	// An absolute pattern that can match home or the directory above it (`/Users/me*`, `/U?ers/me`, `/[U]sers/me`).
	if (t.startsWith("/") && /[*?[]/.test(t) && globHitsHome(t)) return true;
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
	// A glob in command position (`r?`, `[!x]m`) may name a guarded command once the shell expands it.
	if (/[*?[]/.test(name)) {
		const re = globRegExp(name);
		for (const g of GUARDED) {
			if (!re?.test(g)) continue;
			const r = blockedReason([g, ...argv.slice(1)]);
			if (r) return r;
		}
	}
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

/** Alternatives one word may expand to before the segment is judged by its command name alone. */
const MAX_WORD_BRACES = 64;

/** Command names whose arguments decide a block: a word too large to enumerate behind one is refused. */
const GUARDED = new Set(["rm", "chmod", "chown", "chgrp", "dd", "newfs"]);

/** What a refused unenumerable word reports as: the root wipe, the strongest reason. */
const UNENUMERABLE = ["rm", "-rf", "/"];

/**
 * Bash expands each brace word into several words (`{rm,-rf,/}` is three, `a{b,c}d` is two), so the
 * segment's words are rewritten the same way and judged as well as the original, never instead of it.
 * Words are spliced as the shell splices them, so a brace in command position moves what follows.
 * A word over MAX_WORD_BRACES alternatives cannot be enumerated: behind a guarded command (or a
 * braced command word) it is refused, as the home-target check does for the same reason.
 */
function processSegment(
	rawTokens: string[],
	prevTokens: string[] | null,
	out: string[][],
	depth: number,
): void {
	processSegmentOne(rawTokens, prevTokens, out, depth);
	if (
		!rawTokens.some(
			(t) => (t.includes("{") && (t.includes(",") || t.includes(".."))) || t.includes("["),
		)
	)
		return;
	const expanded: string[] = [];
	let overflow = false;
	for (const t of rawTokens) {
		const alts = expandWord(t, MAX_WORD_BRACES);
		if (alts === null) overflow = true;
		else expanded.push(...alts.filter((a) => a !== ""));
	}
	if (overflow) {
		// Judge the whole segment, not its first word: a wrapper (sudo, env X=1, xargs, nice, time,
		// command, exec) or a guarded name anywhere in it means the wide word may feed a wipe.
		const words = rawTokens.filter((t) => !GRAMMAR.has(t));
		const bare = stripPrefix(words);
		const wrapped = bare === null || bare.argv.length !== words.length;
		const named = words.some(
			(t) => GUARDED.has(path.basename(t).toLowerCase()) || OPAQUE_WRAPPERS.has(t),
		);
		const bracedCommand = /[{[]/.test(bare?.argv[0] ?? words[0] ?? "");
		if (wrapped || named || bracedCommand) out.push(UNENUMERABLE);
		return;
	}
	if (expanded.join("\0") !== rawTokens.join("\0"))
		processSegmentOne(expanded, prevTokens, out, depth);
}

function processSegmentOne(
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

/**
 * True when the `'` at index i opens a bash ANSI-C string. Walk back over the run of `$`: a `$`
 * preceded by an odd number of backslashes is escaped and ends the run uncounted; `$$` is the PID,
 * so the quote is ANSI-C only when the count of unescaped `$` in the run is odd.
 */
function opensAnsiC(text: string, i: number): boolean {
	let dollars = 0;
	for (let j = i - 1; j >= 0 && text[j] === "$"; j--) {
		let slashes = 0;
		for (let k = j - 1; k >= 0 && text[k] === "\\"; k--) slashes++;
		if (slashes % 2 === 1) break;
		dollars++;
	}
	return dollars % 2 === 1;
}

/** Value of one ANSI-C escape at s[i] === "\\"; the text it stands for and the index after it. */
function ansiCEscape(s: string, i: number): { text: string; next: number; nul?: boolean } {
	const c = s[i + 1];
	if (c === undefined) return { text: "\\", next: i + 1 };
	const simple: Record<string, string> = {
		a: "\x07",
		b: "\b",
		e: "\x1b",
		E: "\x1b",
		f: "\f",
		n: "\n",
		r: "\r",
		t: "\t",
		v: "\v",
		"\\": "\\",
		"'": "'",
		'"': '"',
		"?": "?",
	};
	if (c in simple) return { text: simple[c], next: i + 2 };
	const code = (digits: string, radix: number, next: number) => {
		const n = Number.parseInt(digits, radix);
		if (n === 0) return { text: "", next, nul: true };
		return { text: n > 0x10ffff ? "" : String.fromCodePoint(n), next };
	};
	let m: RegExpExecArray | null;
	if (c >= "0" && c <= "7") {
		// the shells take an octal escape as one byte, value mod 256: `\457` is `/`
		m = /^[0-7]{1,3}/.exec(s.slice(i + 1)) as RegExpExecArray;
		const n = Number.parseInt(m[0], 8) & 0xff;
		const next = i + 1 + m[0].length;
		return n === 0 ? { text: "", next, nul: true } : { text: String.fromCharCode(n), next };
	}
	if (c === "x" && (m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 2))))
		return code(m[0], 16, i + 2 + m[0].length);
	if (c === "u" && (m = /^[0-9a-fA-F]{1,4}/.exec(s.slice(i + 2))))
		return code(m[0], 16, i + 2 + m[0].length);
	if (c === "U" && (m = /^[0-9a-fA-F]{1,8}/.exec(s.slice(i + 2))))
		return code(m[0], 16, i + 2 + m[0].length);
	if (c === "c" && s[i + 2] !== undefined) {
		const n = s.charCodeAt(i + 2) & 0x1f;
		return n === 0
			? { text: "", next: i + 3, nul: true }
			: { text: String.fromCharCode(n), next: i + 3 };
	}
	return { text: `\\${c}`, next: i + 2 };
}

/**
 * Replace every bash ANSI-C string `$'...'` with its decoded text in plain single quotes, so
 * `$'\x72m'`, `$'rm'`, `$'\057'` and `$'\u002f'` read as `'rm'` and `'/'` and the checks see what
 * the shell will run (#4514). A NUL escape is read two ways (bash drops the tail,
 * zsh may keep it): `keepTail` picks the reading, and `decodeAnsiCVariants` returns both as whole
 * lines, so a caller scans each and a command cannot hide in either. The decoded text is requoted
 * (`'` becomes `'\''`), so a decoded space, `;` or quote cannot change the line's structure.
 * `blind` skips quote tracking for the quote-blind pass, which guesses nothing about context.
 */
export function decodeAnsiC(text: string, blind = false, keepTail = false): string {
	if (!text.includes("$'")) return text;
	let out = "";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (!blind && ch === "\\" && !inSingle) {
			out += ch + (text[i + 1] ?? "");
			i++;
			continue;
		}
		if (ch === "'" && !blind && inSingle) {
			inSingle = false;
			out += ch;
			continue;
		}
		if (ch === "'" && !inSingle && (blind || !inDouble)) {
			if (opensAnsiC(out + text.slice(i), out.length)) {
				let body = "";
				let j = i + 1;
				let stopped = false;
				while (j < text.length && text[j] !== "'") {
					if (text[j] === "\\") {
						const e = ansiCEscape(text, j);
						j = e.next;
						if (!stopped) body += e.text;
						if (e.nul && !keepTail) stopped = true;
					} else {
						if (!stopped) body += text[j];
						j++;
					}
				}
				if (j >= text.length) {
					// unterminated: leave it for the scanners as written
					out += text.slice(i);
					return out;
				}
				// drop the `$` already copied, then emit the decoded body as a plain single-quoted word
				out = `${out.slice(0, -1)}'${body.replace(/'/g, "'\\''")}'`;
				i = j;
				continue;
			}
			if (!blind) inSingle = true;
			out += ch;
			continue;
		}
		if (ch === '"' && !inSingle && !blind) inDouble = !inDouble;
		out += ch;
	}
	return out;
}

/** The line with every `$'...'` decoded, once per NUL reading; one entry when no NUL changes it. */
export function decodeAnsiCVariants(text: string, blind = false): string[] {
	const a = decodeAnsiC(text, blind, false);
	const b = decodeAnsiC(text, blind, true);
	return a === b ? [a] : [a, b];
}

/** The index just past the `)` that closes a `(` already consumed, honouring nesting and quotes. */
function closeParen(text: string, from: number): number {
	let level = 1;
	let q = "";
	let ansi = false;
	for (let i = from; i < text.length; i++) {
		const c = text[i];
		// Plain single quotes take no escapes; an ANSI-C `$'...'` string does.
		if (c === "\\" && (q !== "'" || ansi)) {
			i++;
			continue;
		}
		if (q) {
			if (c === q) {
				q = "";
				ansi = false;
			}
			continue;
		}
		if (c === "'" || c === '"') {
			q = c;
			ansi = c === "'" && opensAnsiC(text, i);
			continue;
		}
		if (c === "(") level++;
		else if (c === ")" && --level === 0) return i;
	}
	return text.length;
}

/**
 * `${IFS}`, `$IFS` and `"${IFS}"` are whitespace to the shell, so `rm${IFS}-rf${IFS}/` runs the
 * root wipe. Returns the text with each spelling replaced by a space, or null when there is none.
 * Callers scan this as an extra variant of the line; the line as written is still scanned.
 */
function expandIfs(text: string): string | null {
	const re = /"?\$\{IFS\}"?|\$IFS(?![A-Za-z0-9_])/g;
	return re.test(text) ? text.replace(re, " ") : null;
}

function scanLine(input: string, out: string[][], depth: number): void {
	// A backslash-newline continues the line; a redirect operator is not a separator.
	const prepped = input
		.replace(/\\\r?\n/g, "")
		.replace(/\d*>&\d+/g, " ")
		.replace(/&>/g, ">");
	// Decode first, then read `${IFS}` as a space: every ANSI-C reading gets the IFS variant too.
	for (const text of decodeAnsiCVariants(prepped)) {
		scanDecoded(text, out, depth);
		const ifs = expandIfs(text);
		if (ifs !== null) scanDecoded(ifs, out, depth);
	}
}

function scanDecoded(text: string, out: string[][], depth: number): void {
	const segments: Array<{ tokens: string[]; piped: boolean }> = [];
	let cur = "";
	let piped = false;
	const flush = (nextPiped: boolean) => {
		if (cur.trim()) segments.push({ tokens: tokenize(cur), piped });
		cur = "";
		piped = nextPiped;
	};

	let inSingle = false;
	let inAnsi = false;
	let inDouble = false;
	let globEnd = -2;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (ch === "\\" && (!inSingle || inAnsi)) {
			cur += ch + (next ?? "");
			i++;
			continue;
		}
		if (ch === "'" && !inDouble) {
			if (inSingle) {
				inSingle = false;
				inAnsi = false;
			} else {
				inSingle = true;
				inAnsi = opensAnsiC(text, i);
			}
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
	scanQuoteBlind(command, out);
	return out;
}

/**
 * Second pass, fail closed. `scanLine` has to guess where quotes begin and end, and a guess
 * that disagrees with the shell hides a command: a quote inside `${...}` in double quotes, a
 * quote in a comment, a quote in a heredoc body. This pass guesses nothing. It splits the
 * whole text on `;` `&` `|` `(` `)` and newline with every quote character treated as an
 * ordinary letter, splits each piece on whitespace, and hands the words to the same segment
 * logic, so the same blockedReason decides. A command is refused if EITHER pass finds a
 * blocked one. Cost, accepted: a blocked command named inside quoted text (an echo, a
 * commit message) is refused too.
 */
function scanQuoteBlind(input: string, out: string[][]): void {
	const prepped = input
		.replace(/\\\r?\n/g, "")
		.replace(/\d*>&\d+/g, " ")
		.replace(/&>/g, ">");
	for (const text of decodeAnsiCVariants(prepped, true)) {
		scanBlindDecoded(text, out);
		const ifs = expandIfs(text);
		if (ifs !== null) scanBlindDecoded(ifs, out);
	}
}

function scanBlindDecoded(text: string, out: string[][]): void {
	for (const piece of text.split(/[;&|()\n\r]/)) {
		// Strip quoting from each word as the shell would: 'x', r'm', \x, "$HOME", $'/'.
		const tokens = piece
			.split(/\s+/)
			.filter(Boolean)
			.map((t) => t.replace(/\$(?=['"])/g, "").replace(/['"\\]/g, ""))
			.filter(Boolean);
		if (tokens.length > 0) processSegment(tokens, null, out, 0);
		// Once quoting is gone a -c script is spread over several words, and the script need not be
		// the very next word (`bash -c -- 'x'`, `bash -cx 'x'`, `bash -ce 'x'`, `bash -c -o errexit 'x'`).
		// After any flag cluster holding a c, read every later word as the start of a command.
		for (let i = 0; i < tokens.length - 1; i++) {
			if (!/^-[a-zA-Z]*c[a-zA-Z]*$/.test(tokens[i])) continue;
			for (let j = i + 1; j < tokens.length; j++) processSegment(tokens.slice(j), null, out, 0);
		}
		// A here-string feeds its words to whatever reads stdin, and a shell runs them.
		// Split at every `<<<` (spaced or glued, as in `bash<<<'x'`) and read every suffix from there.
		// A here-string glued after a closing quote (`"x"<<<y`) leaves its text and the `<<<` in one
		// token, so the text before the `<<<` is cut off as a word of its own: zsh joins both bodies.
		// Every `<<<` starts a new piece, so a wipe riding a later marker is read from that marker too.
		const cut = tokens.flatMap((t) => t.split(/(?=<<<)/).filter(Boolean));
		for (let i = 0; i < cut.length; i++) {
			const at = cut[i].indexOf("<<<");
			if (at < 0) continue;
			const rest = cut[i].slice(at + 3).replace(/^<+/, "");
			const tail = cut.slice(i + 1);
			const words = rest ? [rest, ...tail] : tail;
			for (let j = 0; j < words.length; j++) processSegment(words.slice(j), null, out, 0);
		}
	}
}
