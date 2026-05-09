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

export type ValidatePathResult =
	| { ok: true }
	| { ok: false; reason: string };

// ============================================
// Protected configuration
// ============================================

/** Directories whose contents are always credential-bearing. */
const PROTECTED_DIRS = [".ssh", ".aws", ".kube"];

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

function isDeviceFile(resolved: string, raw: string): boolean {
	// Posix device tree.
	if (resolved.startsWith("/dev/") || resolved === "/dev") return true;
	// Windows device names (NUL, CON, PRN ...) only enforced on win32 to avoid
	// false positives for files literally named "NUL" on case-sensitive FS.
	if (process.platform === "win32") {
		const base = path.basename(raw);
		if (isWindowsDeviceName(base)) return true;
	}
	return false;
}

function resolveLikeRealpath(raw: string, cwd: string): string {
	const absolute = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
	const normalised = path.normalize(absolute);
	// Try realpathSync to collapse symlinks; if missing, walk up to deepest
	// existing ancestor and realpath that.
	try {
		return fs.realpathSync(normalised);
	} catch {
		let cursor = normalised;
		const tail: string[] = [];
		while (cursor && cursor !== path.dirname(cursor)) {
			try {
				const real = fs.realpathSync(cursor);
				return tail.length === 0 ? real : path.join(real, ...tail.reverse());
			} catch {
				tail.push(path.basename(cursor));
				cursor = path.dirname(cursor);
			}
		}
		return normalised;
	}
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

function canonicalHome(): string {
	const home = homeDir();
	try {
		return fs.realpathSync(home);
	} catch {
		return path.resolve(home);
	}
}

function isUnderProtectedDir(resolved: string): boolean {
	const home = canonicalHome();
	for (const dir of PROTECTED_DIRS) {
		const guard = path.join(home, dir);
		if (resolved === guard) return true;
		if (resolved.startsWith(guard + path.sep)) return true;
	}
	return false;
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
export function validatePath(rawPath: string, workingDirectory: string): ValidatePathResult {
	if (typeof rawPath !== "string" || rawPath.length === 0) {
		return { ok: false, reason: "empty path" };
	}

	// 1. UNC paths are rejected before any normalisation.
	if (isUncPath(rawPath)) {
		return { ok: false, reason: "UNC path not allowed" };
	}

	// 2. Resolve through realpath so symlinks cannot tunnel into a protected
	// location. resolveLikeRealpath also normalises '..' segments.
	const resolved = resolveLikeRealpath(rawPath, workingDirectory);

	// 3. SAFE_PATHS escape hatch - checked AFTER resolve so the allowlist
	// matches canonical paths, not user-supplied aliases.
	const overrides = parseSafePaths();
	if (overrides.includes(resolved)) {
		return { ok: true };
	}

	// 4. Device files.
	if (isDeviceFile(resolved, rawPath)) {
		return { ok: false, reason: "device file" };
	}

	// 5. Protected directories under the user's home.
	if (isUnderProtectedDir(resolved)) {
		return { ok: false, reason: "protected credential file" };
	}

	// 6. Protected basenames anywhere (e.g. a .netrc dropped into the project).
	const base = path.basename(resolved);
	if (PROTECTED_BASENAMES.has(base)) {
		return { ok: false, reason: "protected credential file" };
	}

	return { ok: true };
}
