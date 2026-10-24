/**
 * The default read boundary for shell commands (#4880).
 *
 * Every run_command names its paths against a workspace root: EIGHT_WORKSPACE_ROOT when the
 * person set one, else the session's working folder. A command that names a path outside it
 * (`cat ../x`, an absolute path, `~/...`, or a quoted path inside inline python, node, ruby or
 * perl code) is asked about when a person can answer, and refused when nobody can (headless,
 * daemon, CI). It is never run silently.
 *
 * Settings:
 *   EIGHT_WORKSPACE_BOUNDARY=off   turn this boundary off (also 0, false, no)
 *   EIGHT_WORKSPACE_ROOT=<dir>     use a wider (or narrower) root
 *   --allow-read <dir>, /allow-read <dir>   read one more folder this session
 *
 * Allowed outside the root without asking (DEFAULT_READ_ALLOWANCES and readAllowances):
 * system binary, header and library folders, the null and random devices, the temp folders, and the
 * tool's own ~/.8gent data except anything credential-shaped (namesSecret).
 *
 * This is a check on what a command says, not a kernel boundary: code that builds a path at
 * run time (string joins, base64, a script file) is not seen here. The kernel read rule
 * (run-command-sandbox.ts, EIGHT_OS_READ_BOUNDARY=1 on macOS, #4890) is the backstop for that;
 * osReadSpec() below hands it the same root and allowances, so the card explains and the
 * kernel holds.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isPathWithin } from "../core/path-within";
import { readPrefixesFor } from "../eight/read-chain";
import { LINUX_HOME_NEVER_READ } from "./landlock";
import {
	approvedGrants,
	approvedReadEntries,
	isApprovedRead,
	namesSecret,
	noteReadCardShown,
	readAllowPrefixes,
	rememberApprovedReads,
} from "./read-allow";
import { HOME_NEVER_READ, type OsReadSpec, osReadBoundaryOn } from "./run-command-sandbox";
import { sensitiveCredentialPaths } from "./seatbelt";
import { checkCommandBoundary, resolveSafe, tokenize } from "./src/workspace-boundary";

export const READ_BOUNDARY_FLAG = "EIGHT_WORKSPACE_BOUNDARY";

/** On unless EIGHT_WORKSPACE_BOUNDARY is off, 0, false or no. */
export function readBoundaryOn(env: Record<string, string | undefined> = process.env): boolean {
	const v = (env[READ_BOUNDARY_FLAG] ?? "").trim().toLowerCase();
	return !(v === "off" || v === "0" || v === "false" || v === "no");
}

/** Fixed folders and devices a command may name outside the root. */
export const DEFAULT_READ_ALLOWANCES = [
	"/usr/bin",
	"/usr/include",
	"/usr/lib",
	"/usr/libexec",
	"/usr/share",
	"/usr/local/bin",
	"/usr/local/include",
	"/usr/local/lib",
	"/usr/local/share",
	"/bin",
	"/sbin",
	"/opt/homebrew/bin",
	"/opt/homebrew/include",
	"/opt/homebrew/lib",
	"/opt/homebrew/share",
	"/opt/homebrew/opt",
	"/dev/null",
	"/dev/zero",
	"/dev/random",
	"/dev/urandom",
	"/dev/stdin",
	"/dev/stdout",
	"/dev/stderr",
	"/dev/tty",
	"/dev/fd",
	"/tmp",
	"/private/tmp",
];

/** The fixed list plus this machine's temp folder, each also as its real path. */
export function readAllowances(env: Record<string, string | undefined> = process.env): string[] {
	const out = new Set<string>();
	for (const p of [...DEFAULT_READ_ALLOWANCES, os.tmpdir(), env.TMPDIR ?? ""]) {
		if (!p || !path.isAbsolute(p)) continue;
		out.add(path.resolve(p));
		try {
			out.add(fs.realpathSync(p));
		} catch {}
	}
	return [...out];
}

/** The home folder as `~` expands in a command ($HOME) and as the OS reports it, each also real. */
function homeDirs(env: Record<string, string | undefined>): string[] {
	const out = new Set<string>();
	for (const h of [env.HOME ?? "", os.homedir()]) {
		if (!h || !path.isAbsolute(h)) continue;
		out.add(path.resolve(h));
		try {
			out.add(fs.realpathSync(h));
		} catch {}
	}
	return [...out];
}

/** Signing keys under the data folder (kernel read-denied too, #4132). */
const OWN_KEYS = /[\\/]\.8gent[\\/]keys([\\/]|$)/i;

/**
 * Inside the tool's own data folder, what holds the person's memory, browser state, client data
 * or logs is not for a model to read in a shell without a card: databases (memory.db, brain.db),
 * browser profiles and history, client folders, audit logs, backups.
 */
const OWN_PRIVATE =
	/[\\/]\.8gent[\\/](memory[^\\/]*|brain[^\\/]*|clients|browser-[^\\/]*|audit[^\\/]*|backups|app-backups|cron[^\\/]*)([\\/]|$)|\.(db|sqlite3?|db-wal|db-shm)$/i;

/** The tool's own data folder: allowed, except credential-shaped and private paths inside it. */
function ownDataRoots(env: Record<string, string | undefined>): string[] {
	return homeDirs(env).map((h) => path.join(h, ".8gent"));
}

/** Runners that take a program as a string: its quoted and bare path literals are scanned. */
const INTERPRETER =
	/^(python[0-9.]*|node|bun|deno|ruby|perl|php|osascript|[gmn]?awk|sed|tclsh[0-9.]*|wish[0-9.]*|expect|lua(jit|[0-9.]*)|Rscript|R)$/;
const QUOTED_PATH = /(["'])((?:~\/|\.\.\/|\/)[^"'\n]*)\1/g;
/** A bare path in program text, ending at code punctuation: `system("cat ../x")`, `[open ../x]`. */
const CODE_PATH = /(?<![A-Za-z0-9_}.~\-/])((?:~\/|\.\.\/|\/)[^\s"'()`$;|&<>[\]{},]*)/g;

const ANSI_C_ESCAPES: Record<string, string> = {
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

/** The text of a `$'...'` body with its escapes decoded (\xHH, \NNN, \uHHHH, \n ...). */
function decodeAnsiC(body: string): string {
	return body.replace(
		/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)/g,
		(_, e: string) => {
			if (/^[xuU]/.test(e)) return String.fromCodePoint(Number.parseInt(e.slice(1), 16));
			if (/^[0-7]/.test(e)) return String.fromCharCode(Number.parseInt(e, 8) & 0xff);
			if (e[0] === "c") return String.fromCharCode((e.charCodeAt(1) ?? 0) & 0x1f);
			return ANSI_C_ESCAPES[e] ?? `\\${e}`;
		},
	);
}

/**
 * Rewrite `$'...'` (ANSI-C quoting) as the plain single-quoted string the shell passes on, and
 * `$"..."` (locale quoting) as `"..."`, so `cat $'..\x2fx'` is checked as `cat '../x'`. Text
 * inside ordinary quotes is left alone; an unterminated `$'` is left as written.
 */
export function unwrapAnsiC(command: string): string {
	let out = "";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i] as string;
		if (ch === "\\" && !inSingle) {
			out += command.slice(i, i + 2);
			i++;
			continue;
		}
		if (!inSingle && !inDouble && ch === "$" && command[i + 1] === "'") {
			let k = i + 2;
			for (; k < command.length && command[k] !== "'"; k++) if (command[k] === "\\") k++;
			if (k >= command.length) {
				out += command.slice(i);
				break;
			}
			out += `'${decodeAnsiC(command.slice(i + 2, k)).replaceAll("'", "'\\''")}'`;
			i = k;
			continue;
		}
		if (!inSingle && !inDouble && ch === "$" && command[i + 1] === '"') continue;
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		out += ch;
	}
	return out;
}

/** Literal paths written inside a word, not right after a variable (`${D}/x` names no knowable path). */
const LITERAL_PATH = /(?<![A-Za-z0-9_}.~\-/])((?:~\/|\.\.\/|\/)[^\s"'()`$;|&<>]*)/g;

export function literalPaths(word: string): string[] {
	return [...word.matchAll(LITERAL_PATH)].map((m) => m[1]).filter((p) => p !== "/");
}

/** Literal paths inside command substitutions: `cat "$(echo ~/.ssh/id_rsa)"` names ~/.ssh/id_rsa. */
export function substitutionPaths(command: string): string[] {
	return tokenize(command)
		.filter((t) => t.includes("$(") || t.includes("`"))
		.flatMap(literalPaths);
}

/**
 * Path literals inside inline program text when a script runner is in the command:
 * `python3 -c "open('/x')"`, `awk 'BEGIN{getline l<"../x"}'`, `awk '{system("cat ../x")}'`,
 * `echo 'puts [read [open ../x]]' | tclsh`. Quoted paths may hold spaces; bare ones may not.
 */
export function inlineCodePaths(command: string): string[] {
	const tokens = tokenize(command);
	if (!tokens.some((t) => INTERPRETER.test(path.basename(t)))) return [];
	const out: string[] = [];
	for (const t of tokens) {
		for (const m of t.matchAll(QUOTED_PATH)) out.push(m[2] as string);
		for (const m of t.matchAll(CODE_PATH)) if (m[1] !== "/") out.push(m[1] as string);
	}
	return [...new Set(out)];
}

/** A path danger anchor in decoded program text: `~/`, a `../` segment, or an absolute path. */
const CODE_DANGER = /(?:~\/|\.\.(?=[/\\])|\/)[^\s"'`$;|&<>(){}\[\],=]*/g;

const SIMPLE_ESCAPES: Record<string, string> = {
	n: "\n",
	t: "\t",
	r: "\r",
	f: "\f",
	v: "\v",
	b: "\b",
	a: "\x07",
};

/** Decode C and awk string escapes, so `\.\./x`, `\x2e\x2e/x` and `\056\056/x` all read as `../x`. */
function decodeStringEscapes(text: string): string {
	return text.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|[0-7]{1,3}|.)/gs, (_, e: string) => {
		try {
			if (e[0] === "x" || e[0] === "u")
				return String.fromCodePoint(Number.parseInt(e.slice(1), 16));
			if (/^[0-7]/.test(e)) return String.fromCharCode(Number.parseInt(e, 8) & 0xff);
		} catch {
			return e;
		}
		return SIMPLE_ESCAPES[e] ?? e; // unknown escape (\. \/) drops the backslash, keeps the char
	});
}

/**
 * The conservative, class-based scan of an inline program (awk, sed, python, node, ...): join
 * adjacent string literals (drop " and `), decode the string escapes, expand $HOME, then flag
 * every `~/`, `../` or absolute path that appears anywhere in the decoded text. It does not need a
 * well-formed quoted path, so awk literal concatenation (`".."`"/x"`), awk escapes (`"\.\./x"`),
 * and sed's r/R/w filename commands (`r ../x`, `R../x`, `w ../x`) are all seen. A few programs that
 * merely mention `..` or an absolute path in a string are flagged too; that is the intended trade.
 */
export function interpreterProgramPaths(
	command: string,
	env: Record<string, string | undefined>,
): string[] {
	const tokens = tokenize(command);
	if (!tokens.some((t) => INTERPRETER.test(path.basename(t)))) return [];
	const home = env.HOME || os.homedir();
	const out: string[] = [];
	for (const t of tokens) {
		// Adjacent literals join (python and awk concatenate implicitly): `'..' '/x'`, `"..""/x"`.
		const joined = t
			.replace(/["']\s*["']/g, "")
			.replaceAll('"', "")
			.replaceAll("`", "");
		const blob = decodeStringEscapes(joined).replace(/\$\{?HOME\}?/g, home);
		for (const m of blob.matchAll(CODE_DANGER)) {
			const p = m[0];
			if (p === "/" || p === "~/") continue;
			out.push(p.startsWith("~/") ? path.join(home, p.slice(2)) : p);
		}
	}
	return out;
}

/**
 * True when `resolved` (absolute, links followed) is covered by an allowance. Nothing under the
 * home folder is allowed by the temp or system entries, so a home inside a temp folder (a test
 * home, an odd TMPDIR) does not open itself up; ~/.8gent is allowed apart from its secrets.
 */
function allowedOutside(resolved: string, env: Record<string, string | undefined>): boolean {
	const within = (p: string, root: string) => isPathWithin(p, root, process.platform);
	if (ownDataRoots(env).some((r) => within(resolved, r)))
		return !namesSecret(resolved) && !OWN_KEYS.test(resolved) && !OWN_PRIVATE.test(resolved);
	if (homeDirs(env).some((h) => within(resolved, h))) return false;
	return readAllowances(env).some((a) => within(resolved, a));
}

/**
 * A path that does not exist cannot be read. Writes outside the root have their own rules; this
 * keeps a sed script (`s/a/b/w out`) or a not-yet-made output path from reading as a read.
 */
function exists(p: string): boolean {
	try {
		fs.lstatSync(p);
		return true;
	} catch (err) {
		// Unreadable is not absent: a path the OS refuses to stat is still asked about.
		return (
			(err as NodeJS.ErrnoException).code !== "ENOENT" &&
			(err as NodeJS.ErrnoException).code !== "ENOTDIR"
		);
	}
}

const SHELL = /^((ba|z|da|k|a|mk|ya|tc|c)?sh|fish)$/;
/** The bare home folder as a word: `~`, `$HOME`, `${HOME}`. */
const BARE_HOME = /^(~|\$\{?HOME\}?)\/?$/;
/**
 * One `echo` or `printf` and nothing else (no pipe, list, redirect or substitution): it prints its
 * words and reads none, so `echo $HOME` names no file. Anything more (`grep -r x ~`, `cd ~ && ...`,
 * `echo ~ | xargs ls`) is still checked.
 */
const PRINT_ONLY = /^\s*(echo|printf)(\s[^;|&<>`\n]*)?$/;
const printsOnly = (command: string) => PRINT_ONLY.test(command) && !command.includes("$(");
const MAX_NESTING = 3;
const GLOB_CHAR = /[*?[{]/;

/** Bodies of `$(...)`, `<(...)`, `>(...)` (balanced) and backtick pairs: commands inside a command. */
export function substitutionBodies(command: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < command.length; i++) {
		const two = command.slice(i, i + 2);
		if (two === "$(" || two === "<(" || two === ">(") {
			let depth = 1;
			let k = i + 2;
			for (; k < command.length && depth > 0; k++) {
				if (command[k] === "(") depth++;
				else if (command[k] === ")") depth--;
			}
			out.push(command.slice(i + 2, depth === 0 ? k - 1 : k));
		}
	}
	const ticks = [...command.matchAll(/`([^`]*)`/g)].map((m) => m[1] as string);
	return [...out, ...ticks];
}

/** Commands passed as a string: `bash -c '...'`, `sh -c "..."`, `eval '...'`, plus substitution bodies. */
export function nestedCommands(command: string): string[] {
	const out: string[] = [];
	const tokens = tokenize(command);
	for (let i = 0; i < tokens.length; i++) {
		const bin = path.basename(tokens[i] as string);
		if (SHELL.test(bin)) {
			const at = tokens.findIndex((t, k) => k > i && /^-[A-Za-z]*c$/.test(t));
			if (at >= 0 && tokens[at + 1]) out.push(tokens[at + 1] as string);
		} else if (bin === "eval") out.push(tokens.slice(i + 1).join(" "));
		else if (bin === "env") {
			// `env -S 'cat ../x'`, `env -S"cat ../x"`, `env --split-string=...`: a string run as a command.
			for (let k = i + 1; k < tokens.length; k++) {
				const t = tokens[k] as string;
				const split = /^(?:-S|--split-string=?)(.*)$/s.exec(t);
				if (!split) continue;
				const body = split[1] || tokens[k + 1];
				if (body) out.push(body);
				break;
			}
		}
	}
	return [...out, ...substitutionBodies(command)];
}

/**
 * Every word that can name a file, beyond what checkCommandBoundary looks at: an input redirect
 * with no space (`<../x`), `@file` uploads, `--opt=path`, `file://` URLs, `$PWD`/`$HOME`, and
 * globs and braces (reduced to the folder they search). A word built at run time is not here.
 */
export function pathWords(
	command: string,
	cwd: string,
	env: Record<string, string | undefined>,
): string[] {
	const home = env.HOME || os.homedir();
	const out: string[] = [];
	for (const t of tokenize(command)) {
		let w = t;
		if (w.startsWith("<<")) continue;
		w = w.replace(/^\d*<+/, "").replace(/^@/, "");
		// `--opt=path`, `-v name=path` (awk), and a one-letter flag glued to a path (`-f../x`).
		const opt = /^(?:--?[A-Za-z][\w-]*|[A-Za-z_]\w*)=(.*)$/.exec(w);
		if (opt) w = opt[1] as string;
		const glued = /^-[A-Za-z]((?:~\/|\.\.?\/|\/).*)$/.exec(w);
		// A one-character remainder is a separator (`cut -d/`, `awk -F/`), not a path.
		if (glued && (glued[1] as string).length > 1) w = glued[1] as string;
		const url = /^file:\/\/([^?#]*)/.exec(w);
		if (url) {
			try {
				w = decodeURIComponent(url[1] as string);
			} catch {
				w = url[1] as string;
			}
		}
		// `echo $HOME` prints the home folder's name; it reads nothing (PRINT_ONLY).
		if (BARE_HOME.test(w) && printsOnly(command)) continue;
		w = w
			.replace(/^~(?=\/|$)/, home)
			.replace(/^\$\{?HOME\}?(?=\/|$)/, home)
			.replace(/^\$\{?PWD\}?(?=\/|$)/, cwd);
		if (!w || w.startsWith("-") || /[$`()]/.test(w)) continue;
		const g = w.search(GLOB_CHAR);
		if (g >= 0) {
			// A sed or awk script, a regex or a message with a `*` in it is not a path with a glob.
			if (/[\s^$=;'"]/.test(w)) continue;
			const pre = w.slice(0, g);
			w = pre.endsWith("/") || /(^|\/)\.\.$/.test(pre) ? pre : path.dirname(pre);
			if (!w) w = ".";
		}
		out.push(w);
	}
	return out;
}

function isLink(p: string): boolean {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Each existing path a command names outside the root that no allowance covers (resolved). */
export function outsideReads(
	command: string,
	opts: { root: string; cwd?: string; env?: Record<string, string | undefined> },
	depth = 0,
): string[] {
	const env = opts.env ?? process.env;
	const root = opts.root;
	const cwd = opts.cwd ?? root;
	command = unwrapAnsiC(command);
	// Folders the person allowed (--allow-read, /allow-read, named in the ask), for plain reads only.
	const prefixes = readPrefixesFor(command) ?? [];
	// Relative paths resolve where the command runs: a cd prefix chose `cwd` inside the root.
	const quotedCwd = `'${cwd.replaceAll("'", "'\\''")}'`;
	const checked = cwd === root ? command : `cd ${quotedCwd} && ${command}`;
	const out = new Set<string>();
	const literals = [
		...inlineCodePaths(command),
		...interpreterProgramPaths(command, env),
		...substitutionPaths(command),
	];
	for (const v of checkCommandBoundary(checked, root, prefixes).violations) {
		// A word the shell builds at run time (${X:+y}, a glob) has no knowable path: no opinion.
		// Literal paths inside a command substitution are checked above (substitutionPaths).
		if (v.resolved === "<unresolved>") continue;
		if (BARE_HOME.test(v.raw) && printsOnly(command)) continue;
		if (exists(v.resolved) && !allowedOutside(v.resolved, env)) out.add(v.resolved);
	}
	const realRoot = resolveSafe(root, root);
	const insideRoot = (p: string) =>
		isPathWithin(p, realRoot, process.platform) ||
		prefixes.some((x) => isPathWithin(p, path.resolve(x), process.platform));
	// When the root is, or holds, the home folder, credentials and the tool's keys and private
	// data inside it still need a card.
	const rootHoldsHome = homeDirs(env).some((h) => isPathWithin(h, realRoot, process.platform));
	const needsCard = (resolved: string) =>
		insideRoot(resolved)
			? rootHoldsHome &&
				(namesSecret(resolved) ||
					OWN_KEYS.test(resolved) ||
					(ownDataRoots(env).some((r) => isPathWithin(resolved, r, process.platform)) &&
						OWN_PRIVATE.test(resolved)))
			: !allowedOutside(resolved, env);
	for (const p of literals) {
		const expanded = p.startsWith("~/") ? path.join(env.HOME || os.homedir(), p.slice(2)) : p;
		const resolved = resolveSafe(expanded, cwd);
		if (exists(resolved) && needsCard(resolved)) out.add(resolved);
	}
	// Words the tokenizer pass does not see (see pathWords), each followed through links: a link
	// inside the root to a file outside it is a read outside it.
	for (const w of pathWords(command, cwd, env)) {
		// A bare name (no slash) is a read outside only through a link: `cat link-out`.
		if (!w.includes("/") && w !== ".." && !isLink(path.resolve(cwd, w))) continue;
		const resolved = resolveSafe(path.resolve(cwd, w), cwd);
		if (exists(resolved) && needsCard(resolved)) out.add(resolved);
	}
	// Commands inside the command: `bash -c '...'`, `eval '...'`, `$(...)`, backticks.
	if (depth < MAX_NESTING)
		for (const inner of nestedCommands(command))
			for (const p of outsideReads(inner, { root, cwd, env }, depth + 1)) out.add(p);
	return [...out];
}

/**
 * The never-read set (#4897): what the kernel read rule refuses whatever a person answers
 * (credential stores, browser and mail stores, the tool's keys and private data). Returns the
 * plain name of the path class, or null. A card for these changes nothing, so none is shown.
 */
export function neverReadClass(
	resolved: string,
	env: Record<string, string | undefined> = process.env,
): string | null {
	const within = (p: string, root: string) => isPathWithin(p, root, process.platform);
	for (const h of homeDirs(env)) {
		if (sensitiveCredentialPaths(h).some((s) => within(resolved, s)))
			return "credential files such as ~/.ssh";
		if (
			[...HOME_NEVER_READ, ...LINUX_HOME_NEVER_READ].some((rel) =>
				within(resolved, path.join(h, rel)),
			)
		)
			return "browser, mail and password stores";
	}
	for (const r of ownDataRoots(env)) {
		if (!within(resolved, r)) continue;
		if (OWN_KEYS.test(resolved)) return "8gent's own signing keys";
		if (namesSecret(resolved) || OWN_PRIVATE.test(resolved))
			return "8gent's private data in ~/.8gent";
	}
	return null;
}

export type AskPerson = (request: {
	action: string;
	details: string;
	command: string;
}) => Promise<boolean | null>;

export interface ReadBoundaryResult {
	run: boolean;
	/** True when a person approved the outside read: that answer is the command's card. */
	humanApproved?: boolean | null;
	message?: string;
}

/**
 * Decide a command against the read boundary. Null: nothing outside the root (or the boundary
 * is off), no opinion. Otherwise a person is asked; no answer channel means a refusal.
 */
export async function readBoundaryGate(
	command: string,
	opts: {
		env?: Record<string, string | undefined>;
		cwd?: string;
		project?: string;
		ask: AskPerson;
	},
): Promise<ReadBoundaryResult | null> {
	const env = opts.env ?? process.env;
	if (!readBoundaryOn(env)) return null;
	const cwd = opts.cwd ?? process.cwd();
	const root = env.EIGHT_WORKSPACE_ROOT || opts.project || cwd;
	let outside: string[];
	try {
		outside = outsideReads(command, { root, cwd, env });
	} catch {
		outside = ["<unparsed>"];
	}
	// A path never read, whatever the answer: refuse in one plain sentence, show no card (#4897).
	for (const p of outside) {
		const cls = neverReadClass(p, env);
		if (cls)
			return {
				run: false,
				humanApproved: null,
				message:
					`[BLOCKED] Not run: 8gent never reads ${cls}, so no approval was asked [workspace-boundary]. ` +
					`Do not run it again. Tell the person. Command: ${command}`,
			};
	}
	// A folder the person already approved this session is not asked about again.
	// (A credential-shaped name created later inside an approved folder is still asked about.)
	outside = outside.filter((p) => !isApprovedRead(p) || namesSecret(p));
	if (outside.length === 0) return null;
	// One card for the command, naming every outside path it reads.
	const named = outside.join(", ");
	const first = outside[0] ?? "";
	const dir = path.isAbsolute(first) ? path.dirname(first) : "<folder>";
	// The card says exactly what a yes opens: the files named, the folders named with all under
	// them, and which paths get this one run only (too broad, or holding credential-shaped names).
	const grants = new Set(approvedGrants(outside, homeDirs(env)));
	const isFolder = (p: string) => {
		try {
			return fs.statSync(p).isDirectory();
		} catch {
			return false;
		}
	};
	const opens = [...grants].map((g) =>
		isFolder(g) ? `the folder ${g} and everything under it` : `the file ${g}`,
	);
	const once = outside.filter((p) => !grants.has(p));
	const opensText = [
		opens.length ? `A yes opens ${opens.join(", ")} for this session.` : "",
		once.length ? `${once.join(", ")} is read this one time only and asked about again.` : "",
	]
		.filter(Boolean)
		.join(" ");
	let answer: boolean | null;
	try {
		answer = await opts.ask({
			action: "Read outside the working folder",
			details: `This command names ${named}, outside the working folder ${root}. Approve only if you meant it. ${opensText} /allow-read ${dir} allows that whole folder for the session.`,
			command,
		});
	} catch {
		answer = null;
	}
	if (answer !== null) noteReadCardShown();
	if (answer === true) {
		rememberApprovedReads(outside, homeDirs(env));
		return { run: true, humanApproved: true };
	}
	const why =
		answer === false ? "The person declined." : "Nobody can approve it in this session (headless).";
	return {
		run: false,
		humanApproved: answer,
		message:
			`[BLOCKED] Not run: this command names ${named}, outside the working folder ${root} [workspace-boundary]. ${why} ` +
			`Do not run it again. Tell the person; to allow it they can run with --allow-read ${dir} (or /allow-read ${dir} in the TUI), ` +
			`set ${"EIGHT_WORKSPACE_ROOT"} to a wider folder, or set ${READ_BOUNDARY_FLAG}=off. Command: ${command}`,
	};
}

/**
 * The kernel read rule's scope for one command (#4890), or undefined when EIGHT_OS_READ_BOUNDARY
 * is not on. Same root as readBoundaryGate. `approved`: a person approved this command on a card,
 * so the outside paths it names (the ones the card showed) are readable for this run. A path the
 * command builds while it runs was never on the card, and stays refused by the kernel.
 */
export function osReadSpec(
	command: string,
	opts: {
		cwd: string;
		project?: string;
		approved?: boolean;
		env?: Record<string, string | undefined>;
	},
): OsReadSpec | undefined {
	if (!osReadBoundaryOn()) return undefined;
	const env = opts.env ?? process.env;
	const root = path.resolve(env.EIGHT_WORKSPACE_ROOT || opts.project || opts.cwd);
	let approved: string[] = [];
	if (opts.approved) {
		try {
			approved = outsideReads(command, { root, cwd: opts.cwd, env });
		} catch {}
	}
	return {
		root,
		reads: [...readAllowances(env), ...readAllowPrefixes(), ...approvedReadEntries(), ...approved],
		dataRoots: ownDataRoots(env),
		homes: homeDirs(env),
	};
}
