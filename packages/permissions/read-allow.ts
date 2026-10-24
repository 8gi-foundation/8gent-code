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

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { validatePath } from "./path-guard";

/**
 * One session's allowlist. It lives on the session's own object, so it ends with the session,
 * and a turn runs inside it through runInReadScope. `prompt` is rebuilt every turn from that
 * turn's own user message; `manual` holds --allow-read and /allow-read for the session.
 */
export class ReadScope {
	prompt = new Set<string>();
	manual = new Set<string>();
	blocks = new Map<string, number>();
	stop: string | null = null;
	/**
	 * Outside paths a person approved on a read card (#4897): a folder, or one file when its folder
	 * is too broad. In memory only, ends with the session, never written to disk. Kept apart from
	 * `manual` so the file tools do not widen: it feeds the shell's read boundary only.
	 */
	approvedReads = new Set<string>();
	/** Read cards shown to a person this session (#4897), for the session log. */
	cardsShown = 0;
	all(): Set<string> {
		return new Set([...this.prompt, ...this.manual]);
	}
}

const scopeStore = new AsyncLocalStorage<ReadScope>();
/** Used when no session scope is active (tests, a bare executor). */
const fallbackScope = new ReadScope();
const cur = (): ReadScope => scopeStore.getStore() ?? fallbackScope;

/** Run `fn` (a turn) with `scope` as the active allowlist. */
export function runInReadScope<T>(scope: ReadScope, fn: () => T): T {
	return scopeStore.run(scope, fn);
}

/** The sentence a boundary block hands the model. Exact text is part of the contract. */
export const CANNOT_READ_TEXT = "This path cannot be read in this run. Tell the person and stop.";

export function resetReadAllow(scope: ReadScope = cur()): void {
	scope.prompt.clear();
	scope.manual.clear();
	scope.blocks.clear();
	scope.stop = null;
	scope.approvedReads.clear();
	scope.cardsShown = 0;
}

export function readAllowEntries(): string[] {
	return [...cur().all()];
}

/**
 * Credential-looking paths are never allowed, even inside a folder the person named: keys,
 * tokens, env files, shell and cloud credentials, browser profiles, keychains, mail and
 * messages, and the 8gent state that holds sessions and bot keys.
 */
const SECRET_PATH = new RegExp(
	[
		String.raw`(^|[\\/{,])(secrets?|\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.git-credentials|\.kube|\.docker|keychains|master\.passwd)([\\/},]|$)`,
		String.raw`(^|[\\/{,])(\.env[^\\/]*|[^\\/]*\.env|credentials[^\\/]*|id_(rsa|ed25519|ecdsa)[^\\/]*|ssh_host_[^\\/]*|[^\\/]*\.(pem|key|p12|binarycookies)|chat\.db[^\\/]*)([\\/},]|$)`,
		String.raw`\.config[\\/]gh([\\/},]|$)`,
		String.raw`\.8gent[\\/](telegram[^\\/]*|sessions|[^\\/]*token[^\\/]*)([\\/},]|$)`,
		String.raw`Application Support[\\/](Google|Chromium|BraveSoftware|Firefox|Microsoft Edge)([\\/},]|$)`,
		String.raw`\.config[\\/](op|github-copilot|gcloud[\\/]legacy_credentials)([\\/},]|$)`,
		String.raw`(^|[\\/{,])(legacy_credentials|\.password-store|\.pgpass|\.vault-token|\.azure)([\\/},]|$)`,
		String.raw`\.local[\\/]share[\\/]keyrings([\\/},]|$)`,
		String.raw`Application Support[\\/](1Password|Arc)([\\/},]|$)`,
		String.raw`Library[\\/](Cookies|Messages|Mail|Safari)([\\/},]|$)`,
	].join("|"),
	"i",
);

/** True when `text` (a path or a command line) names a credential-looking path. */
export function namesSecret(text: string): boolean {
	return SECRET_PATH.test(text);
}

function expand(p: string, home: string, cwd: string): string {
	if (p === "~") return home;
	if (p.startsWith("~/")) return join(home, p.slice(2));
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** System folders where a directory entry needs two more segments below the root to be allowed. */
const SYSTEM_ROOTS = new Set([
	"etc",
	"var",
	"private",
	"tmp",
	"Volumes",
	"Library",
	"System",
	"usr",
	"bin",
	"sbin",
]);

function segmentsBelow(dir: string, base: string): number {
	return dir.slice(base.length).split(sep).filter(Boolean).length;
}

/**
 * Too wide to hand over as a directory: "/", home and above, anything under home with fewer
 * than 2 segments (so ~/.8gent, ~/Library, ~/Documents are out, ~/.8gent/inbox is in), another
 * user's top folders, and the system roots. The caller falls back to the exact file.
 */
function tooBroad(dir: string, home: string): boolean {
	if (dir === sep || home.startsWith(dir + sep) || dir === home) return true;
	if (dir.startsWith(home + sep)) return segmentsBelow(dir, home) < 2;
	const parts = dir.split(sep).filter(Boolean);
	// macOS aliases /var, /tmp and /etc to /private/...: judge the alias the same as the name.
	if (parts[0] === "private" && parts.length > 1) parts.shift();
	if (parts[0] === "Users") return parts.length < 4; // /Users/<other> and its direct children
	if (SYSTEM_ROOTS.has(parts[0] ?? "")) return parts.length < 3;
	return false;
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
	cur().manual.add(abs);
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
 * Rebuild this turn's allowlist from `text`: the folder of every path named (the file itself
 * when its folder is too wide). The previous turn's prompt entries are dropped first. Only text
 * the person typed belongs here, never tool output or text a model wrote.
 */
export function allowReadsFromPrompt(
	text: string,
	cwd: string = process.cwd(),
	home = homedir(),
): string[] {
	const scope = cur();
	scope.prompt.clear();
	scope.blocks.clear();
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
			scope.prompt.add(entry);
			added.push(entry);
		}
	}
	return added;
}

function under(abs: string, entry: string): boolean {
	return abs === entry || abs.startsWith(entry + sep);
}

/**
 * Does the folder hold a credential-shaped name (SECRET_PATH: .env, .ssh, id_rsa, *.pem, ...)
 * within a few levels? A scan that cannot finish counts as yes. Such a folder is never remembered
 * whole: the kernel's never-read set names fixed places, not these.
 */
function holdsSecretShaped(dir: string, maxEntries = 2000, maxDepth = 3): boolean {
	let seen = 0;
	const walk = (d: string, depth: number): boolean => {
		let names: string[];
		try {
			names = readdirSync(d);
		} catch {
			return true;
		}
		for (const n of names) {
			if (++seen > maxEntries) return true;
			const p = join(d, n);
			if (SECRET_PATH.test(p)) return true;
			if (depth < maxDepth) {
				let isDir = false;
				try {
					isDir = lstatSync(p).isDirectory();
				} catch {}
				if (isDir && walk(p, depth + 1)) return true;
			}
		}
		return false;
	};
	return walk(dir, 1);
}

/**
 * What a yes on a read card opens (#4897), the same list the card shows: each file the command
 * named, exactly; each folder it named, with everything under it, unless that folder is too broad
 * (home, ~/Documents, a system root) or holds a credential-shaped name. Those get no memory: the
 * read runs once and the next one is asked again. Only absolute paths count. A file's folder is
 * never granted: a yes to one note does not open its siblings (8SO review of #4900).
 */
export function approvedGrants(paths: string[], homes: string[] = [homedir()]): string[] {
	const out: string[] = [];
	for (const p of paths) {
		if (!isAbsolute(p)) continue;
		let isDir = false;
		try {
			isDir = statSync(p).isDirectory();
		} catch {}
		if (isDir && (homes.some((h) => tooBroad(p, h)) || holdsSecretShaped(p))) continue;
		out.push(p);
	}
	return out;
}

/** Remember a yes for the rest of the session: the grants above, in memory only. */
export function rememberApprovedReads(
	paths: string[],
	homes: string[] = [homedir()],
	scope: ReadScope = cur(),
): void {
	for (const g of approvedGrants(paths, homes)) scope.approvedReads.add(g);
}

/**
 * A remembered folder is judged again at use time (#4900 second read): a credential-shaped name
 * created under it after the yes (`proj/.env`, `proj/sub/id_rsa`) takes the folder out of memory,
 * for the gate and the kernel reads alike, so a glob or a recursive tool cannot reach it through
 * the approved folder. Same depth and entry budget as at grant time; a scan that cannot finish
 * counts as unsafe. A remembered file is exact and needs no scan.
 */
function stillSafe(entry: string): boolean {
	try {
		if (!statSync(entry).isDirectory()) return true;
	} catch {
		return true; // gone: nothing to read
	}
	return !holdsSecretShaped(entry);
}

/** True when `resolved` (absolute, links followed) lies under a path approved on a read card. */
export function isApprovedRead(resolved: string, scope: ReadScope = cur()): boolean {
	for (const e of scope.approvedReads) if (under(resolved, e) && stillSafe(e)) return true;
	return false;
}

/** The remembered entries that are still safe: what the kernel read rule may be given. */
export function approvedReadEntries(scope: ReadScope = cur()): string[] {
	return [...scope.approvedReads].filter(stillSafe);
}

/** One read card reached a person's screen (#4897). Returns the running count. */
export function noteReadCardShown(scope: ReadScope = cur()): number {
	return ++scope.cardsShown;
}

export function readCardsShown(scope: ReadScope = cur()): number {
	return scope.cardsShown;
}

/** True when `abs` (and its real path, so a link cannot lead out) lies under an allowed entry. */
export function isReadAllowed(abs: string): boolean {
	const list = [...cur().all()];
	if (list.length === 0) return false;
	const target = resolve(abs);
	if (SECRET_PATH.test(target)) return false;
	if (!list.some((e) => under(target, e))) return false;
	let real = target;
	try {
		real = realpathSync(target);
	} catch {
		return true; // does not exist: the read itself reports that
	}
	if (SECRET_PATH.test(real)) return false;
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
	for (const e of cur().all()) {
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
	const blocks = cur().blocks;
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

/** The plain reply a second boundary block set, once. The turn loop ends the turn with it. */
export function takeBoundaryStop(scope: ReadScope = cur()): string | null {
	const s = scope.stop;
	scope.stop = null;
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
	if (r.end && cur().stop === null) cur().stop = r.end;
	return r.text;
}

/** The `/allow-read <dir>` TUI command. Returns the line to show. */
export function runAllowReadCommand(
	args: string[],
	cwd: string = process.cwd(),
	add: (dir: string) => string | null = (d) => addReadAllowDir(d, cwd),
): string {
	const dir = args.join(" ").trim();
	if (!dir) {
		return "Usage: /allow-read <dir>. Lets 8gent read files in that folder this session. Writes stay inside the working folder.";
	}
	const added = add(dir);
	return added
		? `Reading allowed under ${added} for this session. Writes stay inside the working folder.`
		: `Not allowed: ${dir} is too wide, a protected path, or not a path.`;
}
