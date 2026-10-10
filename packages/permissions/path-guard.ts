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
