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
import { resolveSafe } from "./src/workspace-boundary";

/** What the caller will do with the path. The default is "write": the stricter reading. */
export type PathAccess = "read" | "write";

export type ValidatePathResult =
	| { ok: true }
	| { ok: false; reason: string };

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
const PROTECTED_DIRS = [".ssh", ".aws", ".kube", ".8gent/browser-profiles", ".8gent/audit"];

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
	const flat = command.replace(/["'`\\]/g, "").replace(/\s*\+\s*/g, "").toLowerCase();
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
function sessionRecordPatterns(): RegExp[] {
	const dirs = SESSION_RECORD_DIRS.join("|");
	const files = SESSION_RECORD_FILES.map(escapeRe).join("|");
	const pats = [
		new RegExp(`\\.8gent/+(?:${dirs})(?![\\w-])`),
		new RegExp(`\\.8gent/+(?:${files})(?![\\w.-])`),
		new RegExp(`(?:^|[\\s/=])(?:${files})(?![\\w.-])`),
		/\.8gent\/*(?=$|[\s;&|)])/,
	];
	const dataDir = process.env.EIGHT_DATA_DIR;
	if (dataDir) {
		const d = escapeRe(dataDir.toLowerCase().replace(/\/+$/, ""));
		pats.push(new RegExp(`${d}/+(?:${dirs}|${files})`), new RegExp(`${d}/*(?=$|[\\s;&|)])`));
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
	const flat = command.replace(/["'`\\]/g, "").replace(/\s*\+\s*/g, "").toLowerCase();
	const pats = sessionRecordPatterns();
	const names = (t: string) => pats.some((p) => p.test(t));
	// An interpreter that names a record can write it in ways no verb list sees; deny the naming.
	if (INTERPRETER.test(flat) && names(flat)) return true;
	let inRecordDir = false;
	for (const raw of flat.split(/;|&&|\|\||\||\n/)) {
		const seg = raw.trim();
		if (!seg) continue;
		// A redirect onto a record: > or >> (not >&, not 2>&1).
		for (const m of seg.matchAll(/(?:^|[^>&\d])\d?>>?\s*([^\s;&|<>]+)/g)) if (names(m[1])) return true;
		// git checkout/restore/rm/clean of tracked logs rewrites the trace (no workspace root needed).
		if (/(?:^|\s)git\s+(?:checkout|restore|rm|clean)(?=\s|$)/.test(seg)) {
			if (names(seg) || /(?:^|[\s/])(?:logs|sessions|checkpoints)\/|\.log(?![\w.-])/.test(seg)) return true;
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
