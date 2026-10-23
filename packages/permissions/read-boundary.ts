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
 * system binary and library folders, the null and random devices, the temp folders, and the
 * tool's own ~/.8gent data except anything credential-shaped (namesSecret).
 *
 * This is a check on what a command says, not a kernel boundary: code that builds a path at
 * run time (string joins, base64, a script file) is not seen here. Only a kernel read rule
 * (run-command-sandbox.ts, today signing keys only) can stop that.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isPathWithin } from "../core/path-within";
import { readPrefixesFor } from "../eight/read-chain";
import { namesSecret } from "./read-allow";
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
	"/usr/lib",
	"/usr/libexec",
	"/usr/share",
	"/usr/local/bin",
	"/usr/local/lib",
	"/usr/local/share",
	"/bin",
	"/sbin",
	"/opt/homebrew/bin",
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

/** The tool's own data folder: allowed, except credential-shaped paths inside it. */
function ownDataRoots(env: Record<string, string | undefined>): string[] {
	return homeDirs(env).map((h) => path.join(h, ".8gent"));
}

const INTERPRETER = /^(python[0-9.]*|node|bun|deno|ruby|perl|php|osascript)$/;
const QUOTED_PATH = /(["'])((?:~\/|\.\.\/|\/)[^"'\n]*)\1/g;

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

/** Quoted path literals inside inline interpreter code: `python3 -c "open('/x')"` names /x. */
export function inlineCodePaths(command: string): string[] {
	const tokens = tokenize(command);
	if (!tokens.some((t) => INTERPRETER.test(path.basename(t)))) return [];
	const out: string[] = [];
	for (const t of tokens) for (const m of t.matchAll(QUOTED_PATH)) out.push(m[2]);
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
		return !namesSecret(resolved) && !OWN_KEYS.test(resolved);
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
		return (err as NodeJS.ErrnoException).code !== "ENOENT" && (err as NodeJS.ErrnoException).code !== "ENOTDIR";
	}
}

/** Each existing path a command names outside the root that no allowance covers (resolved). */
export function outsideReads(
	command: string,
	opts: { root: string; cwd?: string; env?: Record<string, string | undefined> },
): string[] {
	const env = opts.env ?? process.env;
	const root = opts.root;
	const cwd = opts.cwd ?? root;
	// Folders the person allowed (--allow-read, /allow-read, named in the ask), for plain reads only.
	const prefixes = readPrefixesFor(command) ?? [];
	// Relative paths resolve where the command runs: a cd prefix chose `cwd` inside the root.
	const quotedCwd = `'${cwd.replaceAll("'", "'\\''")}'`;
	const checked = cwd === root ? command : `cd ${quotedCwd} && ${command}`;
	const out = new Set<string>();
	const literals = [...inlineCodePaths(command), ...substitutionPaths(command)];
	for (const v of checkCommandBoundary(checked, root, prefixes).violations) {
		// A word the shell builds at run time (${X:+y}, a glob) has no knowable path: no opinion.
		// Literal paths inside a command substitution are checked above (substitutionPaths).
		if (v.resolved === "<unresolved>") continue;
		if (exists(v.resolved) && !allowedOutside(v.resolved, env)) out.add(v.resolved);
	}
	const realRoot = resolveSafe(root, root);
	for (const p of literals) {
		const expanded = p.startsWith("~/") ? path.join(env.HOME || os.homedir(), p.slice(2)) : p;
		const resolved = resolveSafe(expanded, cwd);
		const inside =
			isPathWithin(resolved, realRoot, process.platform) ||
			prefixes.some((x) => isPathWithin(resolved, path.resolve(x), process.platform));
		if (!inside && exists(resolved) && !allowedOutside(resolved, env)) out.add(resolved);
	}
	return [...out];
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
	if (outside.length === 0) return null;
	const named = outside.slice(0, 3).join(", ") + (outside.length > 3 ? ", ..." : "");
	const first = outside[0] ?? "";
	const dir = path.isAbsolute(first) ? path.dirname(first) : "<folder>";
	let answer: boolean | null;
	try {
		answer = await opts.ask({
			action: "Read outside the working folder",
			details: `This command names ${named}, outside the working folder ${root}. Approve only if you meant it. /allow-read ${dir} allows that folder for the session.`,
			command,
		});
	} catch {
		answer = null;
	}
	if (answer === true) return { run: true, humanApproved: true };
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
