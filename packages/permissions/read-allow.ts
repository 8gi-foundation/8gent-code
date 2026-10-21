/**
 * Per-run read allowlist (#4715). A path the person writes in the ask is in
 * scope for READING: its folder is added here, and read_file, list_files,
 * search_files and read-only run_command checks accept it past the workspace
 * boundary. Writes never consult this list; they stay inside the working
 * directory. Secrets stay blocked: the path guard runs before this list is
 * asked, and a named path the guard refuses is never added.
 *
 * Also holds the terminal-block count: a boundary block on a path is final for
 * that path, and a second block on the same path ends the turn.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { validatePath } from "./path-guard";

const entries = new Set<string>();
const blocks = new Map<string, number>();

/** The sentence a boundary block hands the model. Exact text is part of the contract. */
export const CANNOT_READ_TEXT = "This path cannot be read in this run. Tell the person and stop.";

export function resetReadAllow(): void {
	entries.clear();
	blocks.clear();
}

export function readAllowEntries(): string[] {
	return [...entries];
}

/** Credential-looking paths are never allowed, even inside a folder the person named. */
const SECRET_PATH =
	/(^|[\\/])(secrets?|\.ssh|\.aws|\.gnupg|\.env[^\\/]*|keys\.env|credentials[^\\/]*|id_(rsa|ed25519|ecdsa)[^\\/]*)([\\/]|$)/i;

/** True when `text` (a path or a command line) names a credential-looking path. */
export function namesSecret(text: string): boolean {
	return SECRET_PATH.test(text);
}

function expand(p: string, home: string, cwd: string): string {
	if (p === "~") return home;
	if (p.startsWith("~/")) return join(home, p.slice(2));
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** "/", home, or any folder above home: too wide to hand over for one named file. */
function tooBroad(dir: string, home: string): boolean {
	return dir === sep || dir === home || home.startsWith(dir + sep);
}

/** Allow reads under `dir` (a --allow-read or /allow-read value). Returns the entry, or null when refused. */
export function addReadAllowDir(
	dir: string,
	cwd: string = process.cwd(),
	home = homedir(),
): string | null {
	const abs = expand(dir.trim(), home, cwd);
	if (!abs || tooBroad(abs, home) || SECRET_PATH.test(abs)) return null;
	if (!validatePath(abs, cwd, {}, "read").ok) return null;
	entries.add(abs);
	return abs;
}

/** Absolute and ~/ paths written in the person's text, in order, without trailing punctuation. */
export function extractPromptPaths(text: string, home = homedir()): string[] {
	const out: string[] = [];
	const re = /(?:^|[\s"'`(\[<=,])((?:~|\/)[^\s"'`)\]>,;<]*)/g;
	for (const m of text.matchAll(re)) {
		const raw = m[1].replace(/[.:!?]+$/, "");
		if (raw === "~" || raw === "/" || raw.length < 2) continue;
		if (raw.startsWith("~") && !raw.startsWith("~/")) continue;
		out.push(expand(raw, home, home));
	}
	return [...new Set(out)];
}

/**
 * Add the folder of every path named in `text` (the file itself when its folder
 * is home or wider). Only text the person typed belongs here, never tool output.
 */
export function allowReadsFromPrompt(
	text: string,
	cwd: string = process.cwd(),
	home = homedir(),
): string[] {
	const added: string[] = [];
	for (const p of extractPromptPaths(text, home)) {
		if (SECRET_PATH.test(p) || !validatePath(p, cwd, {}, "read").ok) continue;
		let isDir = false;
		try {
			isDir = existsSync(p) && statSync(p).isDirectory();
		} catch {}
		const base = isDir ? p : dirname(p);
		const entry = tooBroad(base, home) ? (isDir ? null : p) : base;
		if (entry) {
			entries.add(entry);
			added.push(entry);
		}
	}
	return added;
}

function under(abs: string, entry: string): boolean {
	return abs === entry || abs.startsWith(entry + sep);
}

/** True when `abs` (and its real path, so a link cannot lead out) lies under an allowed entry. */
export function isReadAllowed(abs: string): boolean {
	if (entries.size === 0) return false;
	const target = resolve(abs);
	if (SECRET_PATH.test(target)) return false;
	const list = [...entries];
	if (!list.some((e) => under(target, e))) return false;
	let real = target;
	try {
		real = realpathSync(target);
	} catch {
		return true; // does not exist: the read itself reports that
	}
	return list.some((e) => {
		try {
			return under(real, realpathSync(e));
		} catch {
			return under(real, e);
		}
	});
}

/**
 * Folders to hand the boundary checks as extra readable prefixes: each entry as named and
 * as it really resolves (the checks compare real paths, and /tmp is /private/tmp on macOS).
 */
export function readAllowPrefixes(): string[] {
	const out = new Set<string>();
	for (const e of entries) {
		out.add(e);
		try {
			out.add(realpathSync(e));
		} catch {}
	}
	return [...out];
}

/**
 * Record a boundary block on `path`. The first returns the terminal sentence;
 * the second adds `end`, the plain reply that ends the turn.
 */
export function noteBoundaryBlock(path: string): { text: string; end?: string } {
	const key = resolve(path);
	const n = (blocks.get(key) ?? 0) + 1;
	blocks.set(key, n);
	const dir = dirname(key);
	const flag = `--allow-read ${dir} (or /allow-read ${dir} in the TUI)`;
	const text = `Error: ${CANNOT_READ_TEXT} (${key}; it would need ${flag}) [workspace-boundary]`;
	if (n < 2) return { text };
	return {
		text,
		end: `${key} cannot be read in this run. Run again with ${flag} to let me read it.`,
	};
}

let pendingStop: string | null = null;

/** The plain reply a second boundary block set, once. The agent loop ends the turn with it. */
export function takeBoundaryStop(): string | null {
	const s = pendingStop;
	pendingStop = null;
	return s;
}

/**
 * If `text` (a tool result or a thrown message) is a workspace-boundary block, the terminal
 * text to give the model in its place; null otherwise. Callers pass only read-class tools.
 */
export function terminalBoundaryText(text: unknown, cwd: string, home = homedir()): string | null {
	if (typeof text !== "string") return null;
	const m =
		/^(?:Error: )?Path traversal blocked: "([^"]+)" resolves outside working directory/.exec(
			text,
		) ?? /^\[TOOLG8 BLOCKED\][^\n]*\[workspace-boundary\][^\n]*? -> (\S+)/.exec(text);
	if (!m) return null;
	const r = noteBoundaryBlock(expand(m[1], home, cwd));
	if (r.end && pendingStop === null) pendingStop = r.end;
	return r.text;
}

/** The `/allow-read <dir>` TUI command. Returns the line to show. */
export function runAllowReadCommand(args: string[], cwd: string = process.cwd()): string {
	const dir = args.join(" ").trim();
	if (!dir) {
		const now = readAllowEntries();
		return now.length
			? `Readable outside this folder: ${now.join(", ")}. Usage: /allow-read <dir>`
			: "Usage: /allow-read <dir>. Lets 8gent read files in that folder this session. Writes stay inside the working folder.";
	}
	const added = addReadAllowDir(dir, cwd);
	return added
		? `Reading allowed under ${added} for this session. Writes stay inside the working folder.`
		: `Not allowed: ${dir} is too wide, a protected path, or not a path.`;
}
