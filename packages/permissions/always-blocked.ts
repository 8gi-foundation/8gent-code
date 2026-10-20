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
import { resetStructuralBudget, structuralForms } from "./structural-spellings";

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

/** Commands that delete what they are given; `find -exec` of one over a guarded path is a wipe. */
const DELETERS = new Set(["rm", "unlink", "shred", "rmdir"]);

/** find tests whose pattern narrows the match to named files (`-name '*.log'`), unless the pattern is wild. */
const FIND_NAME_TESTS = /^-(name|iname|path|ipath|wholename|iwholename|regex|iregex)$/;

/** Boolean structure that can invert or bypass a name test: `-o`, `-not`, `!`, groups, `,`. */
const FIND_BOOLEAN = /^(-o|-or|-not|!|\(|\\\(|,)$/;
/** find actions: whatever stands before the first one is a filter on it, whatever stands after is not. */
const FIND_ACTION =
	/^-(delete|exec|execdir|ok|okdir|print|print0|printf|ls|fprint|fprint0|fprintf|fls|prune|quit)$/;

/**
 * True when every match of the find expression is a file picked by a non-wild name test that is
 * ANDed in before the first action. Any `-o`, `-not`, `!`, group or `,` anywhere voids it (a narrow
 * name joined to the action by -o, or negated, still reaches everything else), and so does a name
 * test written after the action (`-delete -name x` deletes before it tests).
 */
function findNarrowed(words: string[]): boolean {
	if (words.some((w) => FIND_BOOLEAN.test(w))) return false;
	const act = words.findIndex((w) => FIND_ACTION.test(w));
	const end = act < 0 ? words.length : act;
	for (let i = 0; i < end - 1; i++) {
		if (FIND_NAME_TESTS.test(words[i]) && narrowPattern(words[i], words[i + 1])) return true;
	}
	return false;
}

/** A regex with none of these metacharacters names one literal path, so it cannot match everything. */
const REGEX_META = /[.*+?[\](){}|^$\\]/;

/**
 * Does this pattern, given to this test, pick specific files? A name test needs a non-wild glob. A
 * path-style test (`-path`, `-wholename`) must not be a glob that covers everything under home or
 * root (`/*`, `*`, the home directory, `$HOME/*`, `/*` + `/*`). A regex test counts only when it has
 * no regex metacharacter at all: `.*`, `.+`, `[^x]*` and `(.*)` all match every path.
 */
function narrowPattern(test: string, pat: string): boolean {
	if (/^-i?regex$/.test(test)) return pat !== "" && !REGEX_META.test(pat);
	if (/^-(name|iname)$/.test(test)) return !isWildComponent(pat);
	const comps = pat.split("/").filter(Boolean);
	if (comps.length === 0 || comps.every(isWildComponent)) return false;
	return !(
		isRootTarget(normTarget(pat)) ||
		isHomeTarget(pat) ||
		isHomeTarget(pat.replace(/\/\*+$/, ""))
	);
}

/** The path operands of find: after its leading -H -L -P -D x -On options, up to the first expression word. */
function findPaths(argv: string[]): string[] {
	let i = 1;
	while (i < argv.length) {
		const a = argv[i];
		if (a === "-H" || a === "-L" || a === "-P" || /^-O\d*$/.test(a)) i++;
		else if (a === "-D") i += 2;
		else if (/^-D./.test(a)) i++;
		else break;
	}
	const paths: string[] = [];
	for (; i < argv.length; i++) {
		const a = argv[i];
		if ((a.startsWith("-") && a !== "-") || a === "(" || a === "\\(" || a === "!" || a === ",")
			break;
		paths.push(a);
	}
	return paths;
}

/**
 * find over the root or the home directory with `-delete`, or with `-exec`, `-execdir`, `-ok` or
 * `-okdir` of a delete command: the wipe, spelled through find (#4514 family 4). The command that
 * -exec runs is read the way a top-level line is, so `-exec sh -c '...'` and a wrapper in front of
 * the delete are seen. A name test with a non-wild pattern (`-name '*.log'`) narrows the match to
 * named files, which is ordinary cleanup, so it is not a wipe.
 */
function findWipeReason(argv: string[]): string | null {
	const paths = findPaths(argv).map(normTarget);
	const root = paths.some(isRootTarget);
	if (!root && !paths.some(isHomeTarget)) return null;
	const rest = argv.slice(1);
	if (findNarrowed(rest)) return null;
	const where = root ? "the root filesystem" : "the home directory";
	if (rest.includes("-delete")) return `find -delete over ${where}`;
	for (const payload of findPayloads(argv)) {
		if (payload.length === 0) continue;
		for (const inner of commandArgvs(payload.join(" "))) {
			const n = path.basename(inner[0] ?? "").toLowerCase();
			if (DELETERS.has(n) || (n === "find" && findWipeReason(inner))) {
				return `find -exec of a delete command over ${where}`;
			}
		}
	}
	return null;
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
	// A command name the shell decides at run time (`$r`, `${a[0]}`, an unreadable `$(...)`) may be any
	// guarded command: judged as each of them with the words it was given (#4514). A value the static
	// pass cannot resolve is never treated as safe.
	if (name.includes("$") || name.includes("`")) {
		for (const g of GUARDED) {
			const r = blockedReason([g, ...argv.slice(1)]);
			if (r) return r;
		}
		return null;
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
	if (name === "find") return findWipeReason(argv);
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
const GUARDED = new Set(["rm", "chmod", "chown", "chgrp", "dd", "newfs", "find"]);

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
	upstream: string[][] | null = null,
): void {
	processSegmentOne(rawTokens, prevTokens, out, depth, upstream);
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
		processSegmentOne(expanded, prevTokens, out, depth, upstream);
}

/** The option that names xargs's replacement string (`-I X`, `-IX`, `-i[X]`, `--replace[=X]`, `-J X`), or null. */
function xargsReplStr(tokens: string[]): string | null {
	const at = tokens.findIndex((t) => path.basename(t) === "xargs");
	if (at < 0) return null;
	let repl: string | null = null;
	const takesValue = new Set(["-a", "-d", "-E", "-L", "-n", "-P", "-s", "-R", "-S"]);
	for (let i = at + 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "--" || !t.startsWith("-")) break;
		if (t === "-I" || t === "-J") repl = tokens[++i] ?? "{}";
		else if (/^-[IJ]./.test(t)) repl = t.slice(2);
		else if (t === "-i" || t === "--replace") repl = "{}";
		else if (/^-i./.test(t)) repl = t.slice(2);
		else if (t.startsWith("--replace=")) repl = t.slice(10) || "{}";
		else if (takesValue.has(t)) i++;
	}
	return repl;
}

/**
 * The words a pipe hands to xargs. Each upstream segment's own command name is left out (`echo`
 * is not an argument), and `find ... -name '<specific>'` hands over only named files, never the
 * root or home it searched. Newlines and tabs written as `\\n` or `\\t` separate words, as the
 * shell's printf would.
 */
function producerWords(upstream: string[][]): string[] {
	const words: string[] = [];
	for (const seg of upstream) {
		// Unwrap first: `sudo echo ...` hands over echo's words, not a command named sudo.
		const bare = stripPrefix(seg)?.argv ?? seg;
		if (bare.length === 0) continue;
		if (path.basename(bare[0]) === "find" && findNarrowed(bare)) continue;
		for (const w of bare.slice(1)) words.push(...w.split(/\\[nt0]|\\x00|\s+/).filter(Boolean));
	}
	return words;
}

/** Positional-parameter references in a shell script: `$1`, `${2}`, `$@`, `"$*"`. */
const POSITIONAL = /"?\$(?:\{[0-9@*]+\}|[0-9@*])"?/g;

/** Commands whose output is exactly their arguments or their input reshaped: a pipe from them is readable. */
const TRANSPARENT_PRODUCERS = new Set(["echo", "printf", "tr", "tee", "sort", "uniq", "find"]);

/** A recursive delete, bare or written inside a shell -c string. */
function isRecursiveDeleter(argv: string[]): boolean {
	if (argv.length === 0) return false;
	const name = path.basename(argv[0]).toLowerCase();
	if (name === "rm") return isRecursive(splitArgs(argv.slice(1)).flags);
	if (!SHELLS.has(name)) return false;
	return argv.slice(1).some((a) => RECURSIVE_RM_TEXT.test(a));
}
const RECURSIVE_RM_TEXT =
	/(^|[\s;&|(`{])(\S*\/)?rm\s+(\S+\s+)*?(-[A-Za-z]*[rR][A-Za-z]*|--recursive)(\s|$)/;

/** xargs reading its words from a file (`-a F`, `--arg-file`, `-aF`). */
function xargsArgFile(tokens: string[]): boolean {
	const at = tokens.findIndex((t) => path.basename(t) === "xargs");
	for (let i = at + 1; at >= 0 && i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "--" || !t.startsWith("-")) break;
		if (t === "-a" || t.startsWith("--arg-file") || /^-a./.test(t)) return true;
	}
	return false;
}

/** The words xargs feeds a recursive delete come from somewhere the static pass cannot read. */
function opaqueXargsInput(tokens: string[], upstream: string[][] | null): boolean {
	if (xargsArgFile(tokens)) return true;
	if (upstream && upstream.length > 0) {
		return upstream.some((seg) => {
			const bare = stripPrefix(seg)?.argv ?? seg;
			return !TRANSPARENT_PRODUCERS.has(path.basename(bare[0] ?? "").toLowerCase());
		});
	}
	// No pipe: a here-string or heredoc is literal text, anything else (a terminal, `< file`) is not.
	return !tokens.some((t) => t.startsWith("<<"));
}

/**
 * A -c script that deletes recursively and takes its target from a parameter default (`${1:-/}`,
 * `${d:=x}`) or loops over the positional list (`for d in "$@"`, `for d; do`): the target is
 * decided at run time from words the line does not show, so it is refused behind a deleter.
 */
function unjudgeableScript(script: string): boolean {
	if (!RECURSIVE_RM_TEXT.test(script)) return false;
	return (
		/\$\{[A-Za-z_0-9@*#?-]+:?[-=+?]/.test(script) ||
		/\bfor\s+\w+\s*(;|\bin\s+"?\$(@|\*|\{[@*]\}))/.test(script)
	);
}

/**
 * xargs feeds its stdin words to a command as arguments, or into its replacement string. The
 * producer's words count as those arguments: judged appended, and swapped in for the replacement
 * string one at a time. With no command named (`xargs`, `xargs env`) the words are the command.
 */
function delegateXargs(
	tokens: string[],
	argv: string[],
	upstream: string[][],
	out: string[][],
	depth: number,
): void {
	const words = producerWords(upstream);
	if (words.length === 0) return;
	// With quoting guessed away, a trailing comment (`#'`) can sit where the command was.
	if (argv.length === 0 || argv[0].startsWith("#")) judgeWords(words, out, depth);
	if (argv.length === 0) return;
	const repl = xargsReplStr(tokens);
	if (repl) {
		for (const w of words)
			judgeWords(
				argv.map((a) => a.split(repl).join(w)),
				out,
				depth,
			);
	}
	judgeWords([...argv, ...words], out, depth);
}

/** A delegated command line, read as a segment and, when it is a shell with -c, from every word after the flag. */
function judgeWords(words: string[], out: string[][], depth: number): void {
	processSegmentOne(words, null, out, depth + 1);
	for (let i = 0; i < words.length - 1; i++) {
		if (!/^-[a-zA-Z]*c[a-zA-Z]*$/.test(words[i])) continue;
		for (let j = i + 1; j < words.length; j++)
			processSegmentOne(words.slice(j), null, out, depth + 1);
	}
}

/**
 * `sh -c 'script' name arg...`: the words after the script are its positional parameters, so a
 * script that only says `rm -rf "$@"` runs on them. The script is re-read with every positional
 * reference replaced by all of those words (over-reads: a wipe among them is enough to refuse).
 */
function bindPositionals(argv: string[], out: string[][], depth: number): void {
	const c = argv.findIndex((a, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
	if (c < 0) return;
	let i = c + 1;
	while (i < argv.length && /^[-+]/.test(argv[i])) i += /^[-+][oO]$/.test(argv[i]) ? 2 : 1;
	const script = argv[i];
	const args = argv.slice(i + 1);
	if (script === undefined || args.length === 0 || !POSITIONAL.test(script)) return;
	POSITIONAL.lastIndex = 0;
	scanLine(script.replace(POSITIONAL, ` ${args.join(" ")} `), out, depth + 1);
}

function processSegmentOne(
	rawTokens: string[],
	prevTokens: string[] | null,
	out: string[][],
	depth: number,
	upstream: string[][] | null = null,
): void {
	let tokens = rawTokens;
	while (tokens.length > 0 && GRAMMAR.has(tokens[0])) tokens = tokens.slice(1);
	if (tokens.length === 0) return;
	if (depth > MAX_DEPTH) {
		emitLoose(tokens, out, depth);
		// The nesting cap is reached: a guarded name or a delegating command still in the text is refused.
		const named = tokens.some((t) =>
			t.split(/[\s'"`;|&()$]+/).some((w) => {
				const b = path.basename(w).toLowerCase();
				return GUARDED.has(b) || b === "xargs";
			}),
		);
		if (named) out.push(UNENUMERABLE);
		return;
	}
	const unwrapped = stripPrefix(tokens);
	if (!unwrapped) {
		emitLoose(tokens, out, depth);
		return;
	}
	const argv = unwrapped.argv;
	if (unwrapped.appendsArgs && upstream && upstream.length > 0)
		delegateXargs(tokens, argv, upstream, out, depth);
	if (unwrapped.appendsArgs && isRecursiveDeleter(argv) && opaqueXargsInput(tokens, upstream))
		out.push(UNENUMERABLE);
	if (argv.length === 0) return;
	out.push(argv);
	const name = path.basename(argv[0]);

	if (OPAQUE_WRAPPERS.has(name)) emitLoose(argv.slice(1), out, depth);
	if (name === "eval") scanLine(argv.slice(1).join(" "), out, depth + 1);
	if (SHELLS.has(name)) {
		for (const t of argv.slice(1)) if (/\s/.test(t)) scanLine(t, out, depth + 1);
		bindPositionals(argv, out, depth);
		if (argv.slice(1).some((a) => /\s/.test(a) && unjudgeableScript(a))) out.push(UNENUMERABLE);
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
	for (const decoded of decodeAnsiCVariants(prepped)) {
		for (const text of structuralVariants(decoded, out)) {
			scanDecoded(text, out, depth);
			const ifs = expandIfs(text);
			if (ifs !== null) scanDecoded(ifs, out, depth);
		}
	}
}

/**
 * The text as written plus its structural variants (#4514): variables, arrays, aliases, functions
 * and readable substitutions filled in. Too many alternatives to enumerate takes the overflow refusal.
 */
function structuralVariants(text: string, out: string[][]): string[] {
	const forms = structuralForms(text);
	if (forms !== null) return forms;
	out.push(UNENUMERABLE);
	return [text];
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
		const upstream: string[][] = [];
		for (let k = s; k > 0 && segments[k].piped; k--) upstream.unshift(segments[k - 1].tokens);
		processSegment(segments[s].tokens, prev, out, depth, upstream);
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
	resetStructuralBudget();
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
	for (const decoded of decodeAnsiCVariants(prepped, true)) {
		for (const text of structuralVariants(decoded, out)) {
			// Twice: parens as separators (subshells), and parens as word characters (find's `-regex '(.*)'`).
			for (const keepParens of [false, true]) {
				scanBlindDecoded(text, out, keepParens);
				const ifs = expandIfs(text);
				if (ifs !== null) scanBlindDecoded(ifs, out, keepParens);
			}
			const c = /(^|\s)-[a-zA-Z]*c[a-zA-Z]*\s/.exec(text);
			if (c && unjudgeableScript(text.slice(c.index))) out.push(UNENUMERABLE);
		}
	}
}

function scanBlindDecoded(text: string, out: string[][], keepParens = false): void {
	// Pieces split on the separators; a piece after a single `|` or `|&` is piped from the ones before it.
	// An escaped paren is a word (find's group), not a subshell: keep it in its segment.
	const parts = text
		.replace(keepParens ? /[()]/g : /\\([()])/g, (m, c) => ((c ?? m) === "(" ? "\uE000" : "\uE001"))
		.split(/(\|&?|[;&()\n\r])/);
	let chain: string[][] = [];
	let pipedNext = false;
	for (let pi = 0; pi < parts.length; pi += 2) {
		const piece = parts[pi];
		const sep = parts[pi + 1];
		const upstreamNow = pipedNext && pi >= 2 && parts[pi - 2].trim() !== "" ? chain : [];
		if (!(pipedNext && upstreamNow.length > 0)) chain = [];
		pipedNext = sep !== undefined && sep.startsWith("|") && sep !== "||";
		// Strip quoting from each word as the shell would: 'x', r'm', \x, "$HOME", $'/'.
		const tokens = piece
			.split(/\s+/)
			.filter(Boolean)
			.map((t) =>
				t
					.replace(/\$(?=['"])/g, "")
					.replace(/['"\\]/g, "")
					.replace(/\uE000/g, "(")
					.replace(/\uE001/g, ")"),
			)
			.filter(Boolean);
		if (tokens.length > 0) processSegment(tokens, null, out, 0, upstreamNow);
		if (tokens.length > 0) chain = [...chain, tokens];
		// Once quoting is gone a -c script is spread over several words, and the script need not be
		// the very next word (`bash -c -- 'x'`, `bash -cx 'x'`, `bash -ce 'x'`, `bash -c -o errexit 'x'`).
		// After any flag cluster holding a c, read every later word as the start of a command.
		for (let i = 0; i < tokens.length - 1; i++) {
			if (!/^-[a-zA-Z]*c[a-zA-Z]*$/.test(tokens[i])) continue;
			for (let j = i + 1; j < tokens.length; j++) processSegment(tokens.slice(j), null, out, 0);
			if (unjudgeableScript(tokens.slice(i + 1).join(" "))) out.push(UNENUMERABLE);
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
