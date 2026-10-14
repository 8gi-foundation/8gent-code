/**
 * 8gent Code - Path Guard
 *
 * Static deny-list for credential paths, UNC paths, and device files. Runs
 * BEFORE the NemoClaw policy engine so a misconfigured allow rule cannot
 * lift the guard. Issue #2465.
 *
 * Concept-only port from OpenMonoAgent (AGPL). No source code copied.
 * Behaviour rebuilt from the issue specification.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isPathWithin, pathFor } from "../core/path-within";
import { getKeyPath } from "./goal-state-hmac";
import { securityEnvSnapshot } from "./run-command-sandbox";
import { resolveSafe } from "./src/workspace-boundary";

/** What the caller will do with the path. The default is "write": the stricter reading. */
export type PathAccess = "read" | "write";

export type ValidatePathResult = { ok: true } | { ok: false; reason: string };

/**
 * The machine the path will be opened on. Defaults to the current process and
 * its home directory; tests inject a foreign platform.
 */
export interface PathGuardHost {
	platform?: NodeJS.Platform;
	home?: string;
}

// ============================================
// Protected configuration
// ============================================

/** Directories whose contents are always credential-bearing. browser-profiles holds each named
 *  8gent Browser profile's control token, port file and cookies (#3622). */
const PROTECTED_DIRS = [
	".ssh",
	".aws",
	".kube",
	".8gent/browser-profiles",
	".8gent/audit",
	// state-hmac.key signs /goal state, approval grants and the Table ledger: no read, no write (#4132, 8SO).
	".8gent/keys",
];

/**
 * Files under the home directory that agent tools must never touch, read or
 * write (#3595). settings.json holds postMessage.allowedChats: an agent that
 * could write it could grant itself recipients. The TUI's own settings store
 * writes with plain fs calls, not through this guard, so it is unaffected.
 */
const PROTECTED_HOME_FILES = [
	[".8gent", "settings.json"],
	// The default 8gent Browser control token drives the person's logged-in browser (#3622).
	[".8gent", "browser-control.token"],
	// Agent audit files: the record of what agent tools did is not for agent tools to change (#3735).
	[".8gent", "audit.jsonl"],
	[".8gent", "permissions-audit.jsonl"],
];

/**
 * The session's own records (trace integrity), relative to the data dir (~/.8gent, or
 * EIGHT_DATA_DIR). Tool calls may READ these but never write, delete, truncate or move
 * them. The harness's own writers (session manager, checkpoint store, daemon log,
 * approvals audit) use plain fs calls rather than the guard, so they are unaffected.
 */
export const SESSION_RECORD_DIRS = ["sessions", "logs", "checkpoints"];
export const SESSION_RECORD_FILES = ["daemon.log", "approvals-audit.jsonl"];

/** Audit locations under the data dir (EIGHT_DATA_DIR, default ~/.8gent), relative to it. */
const AUDIT_DATA_DIR_DIRS = ["audit"];
const AUDIT_DATA_DIR_FILES = ["audit.jsonl", "permissions-audit.jsonl"];

/**
 * What 8gent loads and runs at start, relative to ~/.8gent and to EIGHT_DATA_DIR (#4009).
 * hooks.yaml / hooks.json run shell commands on tool events; extensions/ is imported as
 * code; prompts/ is injected into the system prompt; packages/ holds the lock file and
 * installed package code. Tool calls may read these but never write, delete or move them.
 * EIGHT_HOOKS_YAML, when set, names the hooks file and is protected the same way.
 */
export const STARTUP_CODE_FILES = ["hooks.yaml", "hooks.json"];
export const STARTUP_CODE_DIRS = ["extensions", "prompts", "packages"];

/** Basenames that always indicate a credential file regardless of location. */
const PROTECTED_BASENAMES = new Set<string>([
	".gitconfig",
	".netrc",
	".npmrc",
	".pypirc",
	"credentials",
	"id_rsa",
	"id_rsa.pub",
	"id_ed25519",
	"id_ed25519.pub",
	"id_ecdsa",
	"id_ecdsa.pub",
	"id_dsa",
	"id_dsa.pub",
]);

/** Windows reserved device names (NUL, CON, PRN, AUX, COM1-9, LPT1-9). */
const WINDOWS_DEVICES = new Set<string>([
	"CON",
	"PRN",
	"AUX",
	"NUL",
	"COM1",
	"COM2",
	"COM3",
	"COM4",
	"COM5",
	"COM6",
	"COM7",
	"COM8",
	"COM9",
	"LPT1",
	"LPT2",
	"LPT3",
	"LPT4",
	"LPT5",
	"LPT6",
	"LPT7",
	"LPT8",
	"LPT9",
]);

// ============================================
// Helpers
// ============================================

function homeDir(): string {
	// Test hook: allow tests to override the home root for fixture safety.
	return process.env.EIGHT_FAKE_HOME || os.homedir();
}

/**
 * The bot env file named by postMessage.botEnvFile in <home>/.8gent/settings.json
 * (#3838), or null. It holds the posting key, so file tools treat it like a
 * credential file. post_message reads the same setting through this function.
 */
export function configuredBotEnvFile(home: string): string | null {
	try {
		const f = JSON.parse(fs.readFileSync(path.join(home, ".8gent", "settings.json"), "utf8"))
			?.postMessage?.botEnvFile;
		if (typeof f !== "string" || f.trim() === "") return null;
		const file = f.startsWith("~/") ? path.join(home, f.slice(2)) : f;
		return path.isAbsolute(file) ? file : null;
	} catch {
		return null;
	}
}

function isUncPath(raw: string): boolean {
	// Windows UNC: starts with \\ or // followed by host/share segment.
	if (raw.startsWith("\\\\")) return true;
	// Unix-like: any path with three or more leading slashes is suspicious.
	if (raw.startsWith("//")) return true;
	return false;
}

/** Public for tests. */
export function isWindowsDeviceName(basename: string): boolean {
	const stem = basename.split(".")[0]?.toUpperCase() ?? "";
	return WINDOWS_DEVICES.has(stem);
}

function isDeviceFile(resolved: string, raw: string, platform: NodeJS.Platform): boolean {
	// Posix device tree.
	if (resolved.startsWith("/dev/") || resolved === "/dev") return true;
	// On win32 resolve() turns "/dev/tty" into "D:\dev\tty", but the commands run in a POSIX
	// shell (Git Bash), where the spelling the model wrote IS the device. Judge that spelling too.
	const asWritten = path.posix.normalize(raw.replaceAll("\\", "/"));
	if (asWritten.startsWith("/dev/") || asWritten === "/dev") return true;
	// Windows device names (NUL, CON, PRN ...) only enforced on win32 to avoid
	// false positives for files literally named "NUL" on case-sensitive FS.
	if (platform === "win32") {
		const base = path.win32.basename(raw);
		if (isWindowsDeviceName(base)) return true;
	}
	return false;
}

function parseSafePaths(): string[] {
	const raw = process.env.SAFE_PATHS;
	if (!raw || raw.trim() === "") return [];
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.map((s) => {
			try {
				return fs.realpathSync(s);
			} catch {
				return path.resolve(s);
			}
		});
}

function isUnderProtectedDir(resolved: string, home: string, platform: NodeJS.Platform): boolean {
	const flavor = pathFor(platform);
	const canonicalHome = resolveSafe(home, home, platform);
	return PROTECTED_DIRS.some((dir) =>
		isPathWithin(resolved, flavor.join(canonicalHome, ...dir.split("/")), platform),
	);
}

/** macOS (APFS default) and Windows open the same file under any case of its name. */
function foldsCase(platform: NodeJS.Platform): boolean {
	return platform === "darwin" || platform === "win32";
}

/** The protected startup-code locations, canonical (realpath, case-folded where the FS folds). */
function startupCodeTargets(host: Required<PathGuardHost>): { files: string[]; dirs: string[] } {
	const { platform, home } = host;
	const flavor = pathFor(platform);
	const fold = (s: string) => (foldsCase(platform) ? s.toLowerCase() : s);
	const roots = [flavor.join(home, ".8gent")];
	if (process.env.EIGHT_DATA_DIR) roots.push(process.env.EIGHT_DATA_DIR);
	const files: string[] = [];
	const dirs: string[] = [];
	for (const r of roots) {
		const root = resolveSafe(r, home, platform);
		for (const f of STARTUP_CODE_FILES) files.push(fold(flavor.join(root, f)));
		for (const d of STARTUP_CODE_DIRS) dirs.push(fold(flavor.join(root, d)));
	}
	if (process.env.EIGHT_HOOKS_YAML)
		files.push(fold(resolveSafe(process.env.EIGHT_HOOKS_YAML, home, platform)));
	return { files, dirs };
}

/**
 * True when `resolved` (an absolute, realpath'd path) is one of the startup-code files or
 * lies inside one of the startup-code dirs (#4009). A project's own `.8gent/` is not
 * affected unless the project is HOME (or the data dir).
 */
export function isStartupCodePath(resolved: string, host: PathGuardHost = {}): boolean {
	const h = { platform: host.platform ?? process.platform, home: host.home ?? homeDir() };
	const target = foldsCase(h.platform) ? resolved.toLowerCase() : resolved;
	const { files, dirs } = startupCodeTargets(h);
	return files.includes(target) || dirs.some((d) => isPathWithin(target, d, h.platform));
}

// ============================================
// Public API
// ============================================

/**
 * Validate a path before any filesystem tool acts on it.
 *
 * Returns `{ ok: true }` if the path is safe to act on, or
 * `{ ok: false, reason }` if it must be denied. Callers (the policy engine,
 * any direct tool integration) MUST treat a `false` result as a hard deny
 * and skip further policy evaluation.
 */
export function validatePath(
	rawPath: string,
	workingDirectory: string,
	host: PathGuardHost = {},
	access: PathAccess = "write",
): ValidatePathResult {
	const platform = host.platform ?? process.platform;
	if (typeof rawPath !== "string" || rawPath.length === 0) {
		return { ok: false, reason: "empty path" };
	}

	// 0. A leading ~ means home, as the file tools expand it; compare what they will
	// open, not the spelling (a "~/.8gent/settings.json" bypass, #3595).
	if (rawPath === "~" || rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
		rawPath = pathFor(platform).join(host.home ?? homeDir(), rawPath.slice(1));
	}

	// 1. UNC paths are rejected before any normalisation.
	if (isUncPath(rawPath)) {
		return { ok: false, reason: "UNC path not allowed" };
	}

	// 2. Resolve through realpath so symlinks cannot tunnel into a protected
	// location. resolveSafe also normalises '..' segments.
	const resolved = resolveSafe(rawPath, workingDirectory, platform);

	// 3. SAFE_PATHS escape hatch - checked AFTER resolve so the allowlist
	// matches canonical paths, not user-supplied aliases.
	const overrides = parseSafePaths();
	if (overrides.includes(resolved)) {
		return { ok: true };
	}

	// 4. Device files.
	if (isDeviceFile(resolved, rawPath, platform)) {
		return { ok: false, reason: "device file" };
	}

	// 5. Protected directories under the user's home.
	if (isUnderProtectedDir(resolved, host.home ?? homeDir(), platform)) {
		return { ok: false, reason: "protected credential file" };
	}

	// 5b. Protected files under home, compared on the realpath of both sides.
	{
		const flavor = pathFor(platform);
		const home = host.home ?? homeDir();
		for (const parts of PROTECTED_HOME_FILES) {
			const target = resolveSafe(flavor.join(home, ...parts), home, platform);
			if (resolved === target) return { ok: false, reason: "protected settings file" };
		}
	}

	// 5b2. The configured post_message bot env file (#3838), wherever it lives.
	{
		const home = host.home ?? homeDir();
		const envFile = configuredBotEnvFile(home);
		if (envFile && resolved === resolveSafe(envFile, home, platform)) {
			return { ok: false, reason: "protected credential file" };
		}
	}

	// 5c. The same audit files under a relocated data dir (EIGHT_DATA_DIR) (#3735).
	{
		const dataDir = process.env.EIGHT_DATA_DIR;
		if (dataDir) {
			const flavor = pathFor(platform);
			const root = resolveSafe(dataDir, dataDir, platform);
			if (
				AUDIT_DATA_DIR_DIRS.some((d) => isPathWithin(resolved, flavor.join(root, d), platform)) ||
				AUDIT_DATA_DIR_FILES.some((f) => resolved === flavor.join(root, f))
			) {
				return { ok: false, reason: "protected audit file" };
			}
		}
	}

	// 5c2. The signing keys under a relocated data dir: the startup snapshot's (where the key
	// is read from) and the live one, plus the dir getKeyPath() actually resolves to (snapshot
	// HOME, which a live HOME change does not move) (#4132). Read and write.
	{
		const flavor = pathFor(platform);
		const keyDirs: string[] = [];
		for (const dataDir of new Set([
			securityEnvSnapshot().values.EIGHT_DATA_DIR,
			process.env.EIGHT_DATA_DIR,
		])) {
			if (dataDir) keyDirs.push(flavor.join(resolveSafe(dataDir, dataDir, platform), "keys"));
		}
		try {
			const keyDir = path.dirname(getKeyPath());
			keyDirs.push(resolveSafe(keyDir, keyDir, platform));
		} catch {
			// An in-project key path is refused by getKeyPath itself; nothing more to guard.
		}
		if (keyDirs.some((d) => isPathWithin(resolved, d, platform))) {
			return { ok: false, reason: "protected credential file" };
		}
	}

	// 5d. The session's own records: readable, never writable (trace integrity).
	if (access === "write") {
		const flavor = pathFor(platform);
		const roots = [flavor.join(host.home ?? homeDir(), ".8gent")];
		if (process.env.EIGHT_DATA_DIR) roots.push(process.env.EIGHT_DATA_DIR);
		for (const r of roots) {
			const root = resolveSafe(r, r, platform);
			if (
				SESSION_RECORD_DIRS.some((d) => isPathWithin(resolved, flavor.join(root, d), platform)) ||
				SESSION_RECORD_FILES.some((f) => resolved === flavor.join(root, f)) ||
				// The data dir itself: removing or moving it takes every record with it.
				resolved === root
			) {
				return { ok: false, reason: "protected session record" };
			}
		}
	}

	// 5e. What 8gent loads and runs at start (#4009): hooks, extensions, prompts and
	// packages. A model write there is code that runs on the next start. Reads stay open.
	if (
		access === "write" &&
		isStartupCodePath(resolved, { platform, home: host.home ?? homeDir() })
	) {
		return { ok: false, reason: "protected 8gent startup code" };
	}

	// 6. Protected basenames anywhere (e.g. a .netrc dropped into the project).
	// NTFS matches names case-insensitively, so ID_RSA opens id_rsa.
	const base = pathFor(platform).basename(resolved);
	if (PROTECTED_BASENAMES.has(platform === "win32" ? base.toLowerCase() : base)) {
		return { ok: false, reason: "protected credential file" };
	}

	return { ok: true };
}

/**
 * True when a shell command names an agent audit file or directory. A speed
 * bump, not a parser: the file-tool checks above are the boundary. Quoting,
 * escapes and string concatenation are stripped before matching (#3735).
 */
export function commandTouchesAuditFiles(command: string): boolean {
	const dataDir = process.env.EIGHT_DATA_DIR;
	const flat = command
		.replace(/["'`\\]/g, "")
		.replace(/\s*\+\s*/g, "")
		.toLowerCase();
	if (/(?:^|[^a-z0-9_-])(?:permissions-)?audit\.jsonl\b/.test(flat)) return true;
	if (/\.8gent\/+audit\b/.test(flat)) return true;
	if (dataDir) {
		const d = dataDir.toLowerCase().replace(/\/+$/, "");
		if (flat.includes(`${d}/audit`) || flat.includes(`${d}/permissions-audit`)) return true;
	}
	return false;
}

const MUTATING_VERB =
	/(?:^|\s)(?:rm|unlink|rmdir|truncate|shred|mv|tee|dd|perl\s+-\w*i\w*|sed\s+-\w*i\w*|git\s+(?:checkout|restore|rm|clean))(?=\s|$)|\sfind\s.*-delete\b/;

const INTERPRETER =
	/(?:^|[\s;&|(`])(?:python[\d.]*|node|nodejs|perl|ruby|deno|bunx?\s+(?:run\s+)?(?:-e|--eval))(?=\s)/;

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Spellings of a session record (or the data dir itself) in a flattened command. */
function sessionRecordPatterns(includeRoot = true): RegExp[] {
	const dirs = SESSION_RECORD_DIRS.join("|");
	const files = SESSION_RECORD_FILES.map(escapeRe).join("|");
	const pats = [
		new RegExp(`\\.8gent/+(?:${dirs})(?![\\w-])`),
		new RegExp(`\\.8gent/+(?:${files})(?![\\w.-])`),
		new RegExp(`(?:^|[\\s/=])(?:${files})(?![\\w.-])`),
		...(includeRoot ? [/\.8gent\/*(?=$|[\s;&|)])/] : []),
	];
	const dataDir = process.env.EIGHT_DATA_DIR;
	if (dataDir) {
		const lower = dataDir.toLowerCase().replace(/[\\/]+$/, "");
		// The command is flattened with its backslashes removed, so a Windows data dir
		// ("c:\users\x\data") reads "c:usersxdata" there; a command written with forward slashes
		// ("c:/users/x/data") keeps them. Match both spellings.
		for (const form of new Set([lower.replace(/["'`\\]/g, ""), lower.replaceAll("\\", "/")])) {
			const d = escapeRe(form);
			pats.push(new RegExp(`${d}/+(?:${dirs}|${files})`));
			if (includeRoot) pats.push(new RegExp(`${d}/*(?=$|[\\s;&|)])`));
		}
	}
	return pats;
}

/**
 * True when a shell command would write, delete, truncate, move or overwrite one of the
 * session's own records (sessions, logs, checkpoints, daemon.log, approvals-audit.jsonl),
 * or check tracked logs back out of git. Reads (cat, tail, grep, ls) are not flagged.
 * A speed bump, not a parser: the file-tool checks are the boundary, and the real
 * boundary is seatbelting run_command (#3612).
 */
export function commandMutatesSessionRecords(command: string): boolean {
	const flat = command
		.replace(/["'`\\]/g, "")
		.replace(/\s*\+\s*/g, "")
		.toLowerCase();
	const pats = sessionRecordPatterns();
	const names = (t: string) => pats.some((p) => p.test(t));
	// An interpreter that names a record can write it in ways no verb list sees; deny the naming.
	if (INTERPRETER.test(flat) && sessionRecordPatterns(false).some((p) => p.test(flat))) return true;
	let inRecordDir = false;
	for (const raw of flat.split(/;|&&|\|\||\||\n/)) {
		const seg = raw.trim();
		if (!seg) continue;
		// A redirect onto a record: > or >> (not >&, not 2>&1).
		for (const m of seg.matchAll(/(?:^|[^>&\d])\d?>>?\s*([^\s;&|<>]+)/g))
			if (names(m[1])) return true;
		// git checkout/restore/rm/clean of tracked logs rewrites the trace (no workspace root needed).
		if (/(?:^|\s)git\s+(?:checkout|restore|rm|clean)(?=\s|$)/.test(seg)) {
			if (names(seg) || /(?:^|[\s/])(?:logs|sessions|checkpoints)\/|\.log(?![\w.-])/.test(seg))
				return true;
			continue;
		}
		if (/^cd(?:\s|$)/.test(seg)) {
			inRecordDir = names(seg);
			continue;
		}
		const mutating = MUTATING_VERB.test(` ${seg}`);
		// After cd into the records, any mutating verb counts: the names may be relative or globbed.
		if (inRecordDir && mutating) return true;
		if (!names(seg)) continue;
		if (/(?:^|\s)(?:cp|rsync|install|ln)(?=\s)/.test(seg)) {
			// Copying a record out is a read; copying over one is a write.
			const args = seg.split(/\s+/).filter((a) => !a.startsWith("-"));
			if (names(args[args.length - 1] ?? "")) return true;
			continue;
		}
		if (mutating) return true;
	}
	return false;
}

// ============================================
// Shell: writes to startup code (#4009)
// ============================================

/** Verbs that only read what they name. Anything else naming startup code is a write. */
const READ_ONLY_VERBS = new Set([
	"cat",
	"less",
	"more",
	"head",
	"tail",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"ls",
	"stat",
	"file",
	"wc",
	"diff",
	"cmp",
	"bat",
	"jq",
	"yq",
	"md5",
	"md5sum",
	"shasum",
	"sha1sum",
	"sha256sum",
	"readlink",
	"realpath",
	"test",
	"[",
	"du",
	"tree",
	"nl",
	"od",
	"xxd",
	"hexdump",
	"strings",
	"echo",
	"printf",
	"pwd",
	"basename",
	"dirname",
]);

/** Copy-like verbs: naming startup code as a source is a read, as the destination a write. */
const COPY_VERBS = new Set(["cp", "rsync", "install", "scp", "ditto"]);

/** Prefixes that run the next word as the command. */
const WRAPPERS = new Set(["sudo", "env", "command", "exec", "nohup", "time", "nice", "xargs"]);

const INTERPRETER_VERB =
	/^(?:python[\d.]*|node|nodejs|perl|ruby|deno|bun|bunx|php|lua|osascript|sh|bash|zsh|dash|ksh|source|\.)$/;

/**
 * `.8gent` next to a startup-code name in any spelling once quotes, spaces and `+` are
 * gone: `'.8gent','extensions'`, `'.8' + 'gent' + '/hooks'`, `.8gent/prompts`.
 */
const SPLIT_MENTION = /\.8gent.{0,40}?(?:hooks|extensions|prompts|packages)/i;
function squash(s: string): string {
	return s.toLowerCase().replace(/["'`\s+\\]/g, "");
}

const INTERPRETER_WORD =
	/(?:^|[\s;&|(])(?:\S*\/)?(?:python[\d.]*|node|nodejs|perl|ruby|deno|bunx?|php|lua|osascript|sh|bash|zsh|dash|ksh)(?=\s)/;

/** Text a shell runs without it appearing as words: substitutions, and scripts piped into a shell. */
const SUBSTITUTION = /\$\(|`|<\(/;
const PIPE_TO_SHELL =
	/\|\s*(?:sudo\s+)?(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|python[\d.]*|node|perl|ruby|bun)(?=\s|$)(?!\s+-c\b)/;
const DECODER = /(?:^|[\s|;&(])(?:base64|xxd|openssl|uudecode|gunzip|zcat|gzip\s+-d|rev)(?=\s|$)/;

/** git subcommands that write the work tree or repository they run in. */
const GIT_WRITES = new Set([
	"init",
	"clone",
	"checkout",
	"switch",
	"reset",
	"restore",
	"pull",
	"merge",
	"rebase",
	"apply",
	"am",
	"stash",
	"clean",
	"cherry-pick",
	"revert",
	"worktree",
	"submodule",
]);

const STARTUP_MENTION = new RegExp(
	`\\.8gent[/\\\\]+(?:${[...STARTUP_CODE_FILES, ...STARTUP_CODE_DIRS].map(escapeRe).join("|")})(?![\\w.-])`,
	"i",
);

/** Path-like spans inside a token (`--out=X`, `of=X`, `open(X,w)`). */
const PATH_SPAN = /[~$\w{}./-]*\.8gent[/\\]+[\w./*?{}-]*/gi;

function globToRegExp(glob: string, fold: boolean): RegExp {
	let re = "";
	for (const ch of glob) {
		if (ch === "*") re += "[^/]*";
		else if (ch === "?") re += "[^/]";
		else re += escapeRe(ch);
	}
	return new RegExp(`^${re}$`, fold ? "i" : "");
}

/**
 * True when a shell command would write, delete, move, link or install into what 8gent
 * runs at start: ~/.8gent/hooks.yaml, hooks.json, extensions/, prompts/, packages/ (and
 * the same under EIGHT_DATA_DIR). Reads (cat, ls, grep, cp out) are not flagged, and a
 * project's own `.8gent/` is not flagged unless `cwd` resolves it to HOME.
 *
 * Paths are resolved the way the shell will: `~`, `$HOME`, `${HOME}`, simple `VAR=` values,
 * `cd`, `./` and `..`, realpath (a symlinked HOME), and case on macOS. A speed bump, not a
 * parser: the file-tool checks are the boundary, and the real boundary is seatbelting
 * run_command (#3612).
 */
export function commandWritesStartupCode(
	command: string,
	cwd: string = process.cwd(),
	host: PathGuardHost = {},
): boolean {
	const platform = host.platform ?? process.platform;
	const home = host.home ?? homeDir();
	const fold = foldsCase(platform);
	const flavor = pathFor(platform);
	// Unresolvable text ($(...), backticks, a script piped into a shell): refuse whenever the
	// command mentions home or .8gent at all, and always when the piped script is encoded.
	const lowerHome = home.toLowerCase();
	const mentionsHome =
		/~|\$\{?HOME\b|\.8gent|\.8['"\s+]/i.test(command) || command.toLowerCase().includes(lowerHome);
	const pipedToShell = PIPE_TO_SHELL.test(command);
	if ((SUBSTITUTION.test(command) || pipedToShell) && mentionsHome) return true;
	if (pipedToShell && DECODER.test(command)) return true;
	// Inline interpreter code is split on ; like shell text, so judge it whole.
	if (INTERPRETER_WORD.test(command) && SPLIT_MENTION.test(squash(command))) return true;

	const flat = command.replace(/["'`\\]/g, "").replace(/\s*\+\s*/g, "");
	const vars = new Map<string, string>([["HOME", home]]);
	let dir = cwd;

	const expand = (tok: string): string | null => {
		let t = tok.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => vars.get(a ?? b) ?? m);
		if (t === "~" || t.startsWith("~/")) t = home + t.slice(1);
		return t.includes("$") ? null : t;
	};
	const { files, dirs } = startupCodeTargets({ platform, home });
	const isProtected = (tok: string): boolean => {
		if (!tok) return false;
		const t = expand(tok);
		// An unknown variable: judge the literal spelling.
		if (t === null) return STARTUP_MENTION.test(tok);
		if (/[*?]/.test(t)) {
			const re = globToRegExp(flavor.resolve(dir, t), fold);
			const last = flavor.basename(t);
			return [...files, ...dirs, ...dirs.map((d) => flavor.join(d, last))].some((p) => re.test(p));
		}
		return isStartupCodePath(resolveSafe(t, dir, platform), { platform, home });
	};
	/** The token, every `=` value in it, and every startup-code path span in it. */
	const candidates = (tok: string): string[] => {
		const out = [tok, ...tok.split("=").slice(1)];
		for (const m of tok.matchAll(PATH_SPAN)) out.push(m[0]);
		return out;
	};
	const anyProtected = (tok: string) => candidates(tok).some(isProtected);
	/** HOME itself, ~/.8gent itself or the data dir: a swap or a copy into it lands startup code. */
	const roots = [
		home,
		flavor.join(home, ".8gent"),
		...(process.env.EIGHT_DATA_DIR ? [process.env.EIGHT_DATA_DIR] : []),
	].map((r) => {
		const c = resolveSafe(r, home, platform);
		return fold ? c.toLowerCase() : c;
	});
	const isRootPath = (abs: string) => roots.includes(fold ? abs.toLowerCase() : abs);
	const rootOrProtected = (tok: string): boolean => {
		const t = expand(tok);
		if (t === null) return /^~|\$\{?HOME\b|\.8gent/i.test(tok);
		const r = resolveSafe(t.replace(/(?:[/\\]+\.?)+$/, "") || t, dir, platform);
		return isRootPath(r) || isStartupCodePath(r, { platform, home });
	};
	/** A script file the interpreter will run, if it exists and is small enough to read. */
	const scriptMentions = (file: string | undefined): boolean => {
		const t = file === undefined ? null : expand(file);
		if (t === null) return false;
		try {
			const abs = resolveSafe(t, dir, platform);
			const st = fs.statSync(abs);
			if (!st.isFile() || st.size > 1_000_000) return false;
			return SPLIT_MENTION.test(squash(fs.readFileSync(abs, "utf-8")));
		} catch {
			return false;
		}
	};

	for (const raw of flat.split(/;|&&|\|\||\||\n/)) {
		let seg = raw.trim().replace(/^[({]\s*|\s*[)}]$/g, "");
		if (!seg) continue;
		// A redirect onto startup code: >, >>, &>, 2> (not >&, not 2>&1).
		for (const m of seg.matchAll(/(?:\d|&)?>{1,2}\|?(?!&)\s*([^\s;&|<>()]+)/g))
			if (anyProtected(m[1])) return true;
		seg = seg.replace(/(?:\d|&)?>{1,2}\|?\s*[^\s;&|<>()]+/g, " ").trim();
		let words = seg.split(/\s+/).filter(Boolean);
		// VAR=value assignments, alone or before a command, and export VAR=value.
		if (words[0] === "export" || words[0] === "declare" || words[0] === "local")
			words = words.slice(1);
		while (words.length && /^\w+=/.test(words[0])) {
			const [name, ...rest] = words[0].split("=");
			const value = expand(rest.join("="));
			if (value !== null) vars.set(name, value);
			words = words.slice(1);
		}
		while (words.length && (WRAPPERS.has(words[0]) || /^\w+=/.test(words[0]))) {
			words = words.slice(1);
			while (words.length && words[0].startsWith("-")) words = words.slice(1);
		}
		if (!words.length) continue;
		const verb = flavor.basename(words[0]).toLowerCase();
		const args = words.slice(1);
		if (verb === "cd" || verb === "pushd") {
			const target = args.find((a) => !a.startsWith("-"));
			const t = target === undefined ? home : expand(target);
			if (t !== null && target !== "-") dir = resolveSafe(t, dir, platform);
			continue;
		}
		// Inside startup code, anything but a read writes there, named or not (npm install).
		const inside = isStartupCodePath(resolveSafe(dir, dir, platform), { platform, home });
		if (READ_ONLY_VERBS.has(verb)) continue;
		if (verb === "find") {
			if (
				/\s-(?:delete|exec|execdir|ok|okdir|fprint\w*)\b/.test(` ${args.join(" ")}`) &&
				(inside || args.some(anyProtected))
			)
				return true;
			continue;
		}
		if (inside) return true;
		// An interpreter can write anything it names, in ways no verb list sees: its inline
		// code, and the script file it runs (a file written by an earlier call).
		if (INTERPRETER_VERB.test(verb)) {
			if (STARTUP_MENTION.test(seg) || SPLIT_MENTION.test(squash(raw))) return true;
			const pos = args.filter((a) => !a.startsWith("-"));
			if (scriptMentions(pos[0] === "run" ? pos[1] : pos[0])) return true;
		}
		const positional = args.filter((a) => !a.startsWith("-"));
		if (
			verb === "tar" &&
			(args.some((a) => /^-[a-z]*x|^--extract/i.test(a)) || /^[a-z]*x/i.test(args[0] ?? ""))
		) {
			const cIdx = args.findIndex((a) => a === "-C" || a === "--directory");
			const eq = args.find((a) => a.startsWith("--directory="));
			const target = cIdx >= 0 ? args[cIdx + 1] : eq ? eq.split("=")[1] : ".";
			if (target !== undefined && rootOrProtected(target)) return true;
		}
		if (verb === "unzip" || verb === "7z" || verb === "bsdtar") {
			const dIdx = args.indexOf("-d");
			const oArg = args.find((a) => /^-o./.test(a) && verb === "7z");
			const target = dIdx >= 0 ? args[dIdx + 1] : oArg ? oArg.slice(2) : ".";
			if (target !== undefined && rootOrProtected(target)) return true;
		}
		if (verb === "git") {
			let gdir = ".";
			let i = 0;
			while (i < args.length && args[i].startsWith("-")) {
				if (args[i] === "-C") gdir = args[++i] ?? ".";
				else if (args[i] === "-c") i++;
				i++;
			}
			const sub = args[i];
			const rest = args.slice(i + 1).filter((a) => !a.startsWith("-"));
			if (sub && GIT_WRITES.has(sub)) {
				if (rootOrProtected(gdir)) return true;
				if (
					(sub === "clone" || sub === "init") &&
					rest.length &&
					rootOrProtected(rest[rest.length - 1])
				)
					return true;
			}
		}
		if (verb === "ln" && positional.some(rootOrProtected)) return true;
		if (COPY_VERBS.has(verb)) {
			const pos = positional;
			const tIdx = args.indexOf("-t");
			const dest = tIdx >= 0 ? args[tIdx + 1] : pos[pos.length - 1];
			const srcs = pos.filter((a) => a !== dest);
			if (!dest) continue;
			if (anyProtected(dest) || rootOrProtected(dest)) return true;
			// Copying into a directory lands at dest/<basename of each source>.
			const d = expand(dest);
			if (
				d !== null &&
				srcs.some((s) => isProtected(flavor.join(d, flavor.basename(s.replace(/[/\\]+$/, "")))))
			)
				return true;
			continue;
		}
		if (verb === "mv") {
			const pos = positional;
			// Moving HOME, ~/.8gent or the data dir away (or onto them) swaps the whole tree.
			if (pos.some(anyProtected) || pos.some(rootOrProtected)) return true;
			const dest = expand(pos[pos.length - 1] ?? "");
			if (
				dest !== null &&
				pos
					.slice(0, -1)
					.some((s) => isProtected(flavor.join(dest, flavor.basename(s.replace(/[/\\]+$/, "")))))
			)
				return true;
			continue;
		}
		// Everything else (ln, tee, touch, rm, mkdir, sed -i, dd of=, tar -C, npm, git ...).
		if (args.some(anyProtected)) return true;
	}
	return false;
}
