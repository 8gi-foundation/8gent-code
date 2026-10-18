import { readdirSync } from "node:fs";

/**
 * A read-only inline `python3 -c "..."` needs no approval card (#4421).
 *
 * 2026-10-18 cloud sweep (main eb0aec62): models inspect a task file with
 * `python3 -c "import json; t = json.load(open('task.json')); print(...)"`. The
 * rules (decideRules) pass it, but it is not on the safe list, so every call raised a
 * card; a multi-line card cannot be read by the pilot's approver, which declined it,
 * and a person is shown the same card for a script that only prints a file.
 *
 * Same design as s1-run-own-script.ts: an ALLOWLIST of one exact shape. Anything
 * else is "no opinion" and asks exactly as before. This is text analysis plus ONE readdir
 * of the command's working directory (see the shadow rule below): nothing is executed, no
 * file is opened, and it can only remove a card, never a rule
 * (System One runs on the line before the card and still escalates inline code that
 * deletes; the pre-spawn backstops and the sanitizer run unchanged).
 *
 * `readOnlyInlinePython` answers ok only when ALL hold:
 *   - the line is exactly `python|python3|python3.N [-I] -c "<code>"` or `-c '<code>'`:
 *     one quoted word, nothing after the closing quote, so no `;`, `&&`, pipe,
 *     redirect, second argument, env prefix or cd prefix;
 *   - a double-quoted body has no `$` or backtick; in either quoting the only backslash
 *     escapes allowed are `\n`, `\t`, `\r`, `\'` and `\"` (a `\x5f` would spell an underscore
 *     past the dunder check below, and `\\`, `\<newline>` are shell-eaten or continuations);
 *   - the code is at most 8 KB and every import is `import a, b` of json, re,
 *     collections, itertools or math: no `from`, no `as`, no dotted module;
 *   - each of those module names appears only as `module.attr` with attr on that
 *     module's list below (json.dump, re.sys and json.codecs are not on it), so a module
 *     cannot be passed around or used to reach `sys`, `os` or a writer;
 *   - no identifier starts with an underscore (no dunder, no private attribute), and
 *     none of exec, eval, compile, getattr, setattr, delattr, globals, locals, vars,
 *     breakpoint, input(), help, memoryview, format, format_map (`'{0.x}'.format` walks
 *     attributes), quit, exit, mro, nor anything named write*, dump, or `file=`;
 *   - no shadowing: `python -c` puts the cwd first on sys.path, so a planted json.py (or
 *     a json/ package) would run on `import json`. The command's working directory must
 *     hold no `<mod>`, `<mod>.py`, `<mod>.pyc`, `<mod>.pyd` or `<mod>.so` for the allowed
 *     modules and the stdlib modules they import at load (SHADOWABLE). If the directory
 *     cannot be read, or no cwd is passed, the answer is no (the card). `-I` is accepted but not required;
 *   - every `open` is `open('<relative literal path>')` or with mode 'r' / 'rt': the
 *     path has no leading `/`, `~`, `.` or `..` segment, no dot-directory, and does not
 *     name a secret. A bare `open` (an alias) or a computed path is refused.
 *
 * Not covered, and said plainly: a workspace symlink to a secret (`ln -s ~/.ssh/x notes.txt`)
 * is not caught by a text check on the path; the shadow list is the known load-time imports
 * of these modules, not every module python could import; and a read-only script can still loop forever or print a
 * lot; the tool timeout bounds that, and it is the same as `cat` of a large file.
 */

const MODULE_ATTRS: Readonly<Record<string, ReadonlySet<string> | "any">> = {
	json: new Set(["load", "loads", "dumps", "JSONDecodeError"]),
	re: new Set([
		"findall",
		"finditer",
		"match",
		"search",
		"fullmatch",
		"sub",
		"subn",
		"split",
		"escape",
		"I",
		"IGNORECASE",
		"M",
		"MULTILINE",
		"S",
		"DOTALL",
		"X",
		"VERBOSE",
	]),
	collections: new Set(["Counter", "defaultdict", "OrderedDict", "deque", "namedtuple"]),
	// Built-in C modules with no module references among their attributes.
	itertools: "any",
	math: "any",
};

/** Names a planted file in the cwd must not carry: the allowed modules plus what they import at load. */
const SHADOWABLE: readonly string[] = [
	...Object.keys(MODULE_ATTRS),
	"enum",
	"sitecustomize",
	"usercustomize",
	"linecache",
	"traceback",
	"functools",
	"operator",
	"keyword",
	"heapq",
	"reprlib",
	"copyreg",
	"weakref",
	"types",
	"sre_compile",
	"sre_parse",
	"sre_constants",
];

const MAX_CODE = 8 * 1024;
const PYTHON = /^(?:python|python3|python3\.\d{1,2})$/;
const BANNED_WORD =
	/\b(?:exec|eval|compile|getattr|setattr|delattr|globals|locals|vars|breakpoint|help|memoryview|format|format_map|quit|exit|mro|dump|write\w*)\b|\binput\s*\(/;
/** An identifier or attribute starting with an underscore; a bare `_` is allowed. */
const UNDERSCORE_NAME = /(?:^|[^A-Za-z0-9_])_[A-Za-z0-9_]/;
const FILE_KW = /\bfile\s*=/;
const SECRET_NAME =
	/(?:^|[/._-])(?:env|secret|secrets|credential|credentials|token|tokens|password|passwd|id_rsa|id_ed25519|pem|key|keys|keychain|netrc|npmrc|pypirc|apikey|auth|cookie|kubeconfig)(?:$|[/._-])/i;
const OPEN_LITERAL = /^open\(\s*(['"])([^'"\\\s]+)\1\s*(?:,\s*(['"])(r|rt)\3\s*)?\)/;

export type InlinePython = { ok: true; reason: string } | { ok: false };
const NO: InlinePython = { ok: false };

/** The code in `python -c "<code>"`, or null when the line is not exactly that shape. */
function extractCode(command: string): string | null {
	const line = command.replace(/[ \t]+$/, "");
	const m = /^(\S+)[ \t]+(?:-I[ \t]+)?-c[ \t]+(["'])/.exec(line);
	if (!m || !PYTHON.test(m[1] as string)) return null;
	const quote = m[2] as string;
	const body = line.slice(m[0].length);
	if (!body.endsWith(quote)) return null;
	const code = body.slice(0, -1);
	if (code.includes(quote)) return null; // the quote closes earlier: something follows it
	if (/\\(?![ntr'"])/.test(code)) return null; // no \x, \u, \N, octal, \\, line continuation
	if (quote === "'") return code;
	if (/[$`]/.test(code)) return null;
	return code;
}

function importsOk(code: string): boolean {
	// Every `import` / `from` keyword must be part of a plain `import a, b` line.
	const keywords = code.match(/\b(?:import|from)\b/g) ?? [];
	const plain = [
		...code.matchAll(/(?:^|[;\n])[ \t]*import[ \t]+([A-Za-z0-9_., \t]+?)[ \t]*(?=[;\n]|$)/g),
	];
	if (keywords.some((k) => k === "from")) return false;
	if (plain.length !== keywords.length) return false;
	return plain.every((p) =>
		(p[1] as string)
			.split(",")
			.map((s) => s.trim())
			.every((name) => Object.hasOwn(MODULE_ATTRS, name)),
	);
}

function moduleUseOk(code: string): boolean {
	// Take the import lines out first, then every module name left must be `name.attr`.
	const rest = code.replace(
		/(^|[;\n])[ \t]*import[ \t]+[A-Za-z0-9_., \t]+?[ \t]*(?=[;\n]|$)/g,
		"$1",
	);
	for (const [name, attrs] of Object.entries(MODULE_ATTRS)) {
		const re = new RegExp(`(?<![A-Za-z0-9_.])${name}\\b(?!\\s*\\.\\s*[A-Za-z0-9_])`, "g");
		if (re.test(rest)) return false; // used bare: passed around or aliased
		if (attrs === "any") continue;
		const use = new RegExp(`(?<![A-Za-z0-9_.])${name}\\s*\\.\\s*([A-Za-z0-9_]+)`, "g");
		for (const u of rest.matchAll(use)) if (!attrs.has(u[1] as string)) return false;
	}
	return true;
}

function opensOk(code: string): boolean {
	for (const m of code.matchAll(/\bopen\b/g)) {
		if (code[(m.index ?? 0) - 1] === ".") return false; // x.open: not the builtin
		const lit = OPEN_LITERAL.exec(code.slice(m.index ?? 0));
		if (!lit) return false;
		const p = lit[2] as string;
		if (p.startsWith("/") || p.startsWith("~") || p.startsWith("-")) return false;
		const segs = p.split("/");
		if (segs.some((s) => s === "" || s.startsWith("."))) return false;
		if (SECRET_NAME.test(p)) return false;
	}
	return true;
}

/** True when the directory holds a file or folder python would import in place of a stdlib module. */
function shadowed(cwd: string): boolean {
	let entries: string[];
	try {
		entries = readdirSync(cwd);
	} catch {
		return true; // cannot look: cannot vouch
	}
	const names = new Set(SHADOWABLE);
	for (const e of entries) {
		if (names.has(e)) return true;
		const dot = e.lastIndexOf(".");
		if (dot > 0 && names.has(e.slice(0, dot)) && /^\.(?:py|pyc|pyd|so)$/.test(e.slice(dot)))
			return true;
		// extension modules: json.cpython-312-darwin.so
		const first = e.indexOf(".");
		if (first > 0 && names.has(e.slice(0, first)) && e.endsWith(".so")) return true;
	}
	return false;
}

export function readOnlyInlinePython(command: string, cwd?: string): InlinePython {
	if (typeof command !== "string" || command.length > MAX_CODE + 64) return NO;
	const code = extractCode(command);
	if (code === null || code.trim() === "" || code.length > MAX_CODE) return NO;
	if (!/^[\t\n\r\x20-\x7e]*$/.test(code)) return NO; // ASCII only: no look-alike names
	if (BANNED_WORD.test(code) || FILE_KW.test(code) || UNDERSCORE_NAME.test(code)) return NO;
	if (!importsOk(code) || !moduleUseOk(code) || !opensOk(code)) return NO;
	if (cwd === undefined || shadowed(cwd)) return NO; // no cwd: cannot vouch, ask
	return { ok: true, reason: "inline python that only reads a workspace file and prints" };
}

/**
 * The command to spawn when the allowlist is what admits it: the same line with `-I` after
 * the interpreter (isolated mode: no cwd on sys.path, no PYTHON* env, no user site), so a
 * planted traceback.py, json.py or sitecustomize.py in the cwd is never imported, whatever
 * module python reaches for. Any other command, or one the allowlist refuses, is returned
 * unchanged. The admitted shape is exact, so the rewrite is deterministic.
 */
export function isolatedInlinePython(command: string, cwd: string): string {
	if (!readOnlyInlinePython(command, cwd).ok) return command;
	return command.replace(/^(\S+)([ \t]+)(?!-I\b)-c([ \t])/, "$1$2-I$2-c$3");
}
