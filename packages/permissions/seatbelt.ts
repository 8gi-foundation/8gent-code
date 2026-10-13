/**
 * 8gent Code - macOS Seatbelt Sandbox (NemoClaw v2, issue #2756 step 2)
 *
 * Generates sandbox-exec (SBPL) profiles so an exec tool runs with the
 * least filesystem and network reach it declared - enforced by the OS
 * kernel, not by convention. Deny by default: the process may read the
 * system surface it needs to run at all, read/write only its work dir,
 * per-session scratch dir, and any scopes its capability manifest grants,
 * and nothing else. Sensitive credential paths (~/.ssh, ~/.aws, keychains,
 * the 8gent key store) are denied LAST so they win even when a manifest
 * scope would otherwise cover them.
 *
 * The done-criterion of the epic, at the OS layer: a malicious command
 * cannot read ~/.ssh even if its tool's manifest granted ${home}.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveManifestFsScopes } from "./capability-manifest.js";

// ============================================
// Types
// ============================================

/** Everything needed to build one seatbelt profile. */
export interface SeatbeltSpec {
	/** Directory the command may read AND write. Required. */
	workDir: string;
	/** Extra directories the command may read (manifest read scopes). */
	readPaths?: string[];
	/** Extra directories the command may read and write (manifest write scopes). */
	writePaths?: string[];
	/** Allow outbound network. Default: false (deny-default blocks it). */
	allowNetwork?: boolean;
	/**
	 * Paths denied even inside allowed scopes. Defaults to
	 * sensitiveCredentialPaths(). Pass [] to disable only in tests.
	 */
	denyPaths?: string[];
}

// ============================================
// Availability
// ============================================

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** True when this host can enforce seatbelt profiles (macOS only). */
export function isSeatbeltAvailable(): boolean {
	return process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC);
}

/** Absolute path of the sandbox-exec binary. */
export function seatbeltBinary(): string {
	return SANDBOX_EXEC;
}

// ============================================
// Sensitive path defaults
// ============================================

function homeDir(): string {
	// Same test hook as path-guard / capability-manifest.
	return process.env.EIGHT_FAKE_HOME || os.homedir();
}

/**
 * Credential stores that must never be readable from inside the sandbox,
 * regardless of what scopes a manifest granted. Each entry is emitted as
 * both (literal p) and (subpath p) so files and directories are covered.
 */
export function sensitiveCredentialPaths(): string[] {
	const home = homeDir();
	const dataDir = process.env.EIGHT_DATA_DIR || path.join(home, ".8gent");
	return [
		path.join(home, ".ssh"),
		path.join(home, ".aws"),
		path.join(home, ".gnupg"),
		path.join(home, ".netrc"),
		path.join(home, ".npmrc"),
		path.join(home, ".kube"),
		path.join(home, ".docker", "config.json"),
		path.join(home, ".config", "gh"),
		path.join(home, "Library", "Keychains"),
		path.join(dataDir, "keys"),
		// 8gent Browser control tokens (#3622): the default one drives the person's logged-in
		// browser; browser-profiles holds each named profile's token, port file and cookies.
		path.join(home, ".8gent", "browser-control.token"),
		path.join(home, ".8gent", "browser-profiles"),
	];
}

// ============================================
// Profile generation (pure)
// ============================================

/** Escape a path for an SBPL double-quoted string. */
function sbplString(p: string): string {
	return `"${p.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function subpaths(paths: string[]): string {
	return paths.map((p) => `(subpath ${sbplString(path.normalize(p))})`).join(" ");
}

function literalsAndSubpaths(paths: string[]): string {
	return paths
		.map((p) => {
			const n = path.normalize(p);
			return `(literal ${sbplString(n)}) (subpath ${sbplString(n)})`;
		})
		.join(" ");
}

/**
 * Build a deny-by-default SBPL profile from a spec.
 *
 * Rule order matters: in SBPL the LAST matching rule wins, so the profile
 * is layered allow-system, allow-scopes, network, then sensitive denies
 * at the very end so nothing can override them.
 */
export function buildSeatbeltProfile(spec: SeatbeltSpec): string {
	const workDir = path.normalize(spec.workDir);
	if (!path.isAbsolute(workDir)) {
		throw new Error(`seatbelt: workDir must be absolute, got "${spec.workDir}"`);
	}
	const readPaths = spec.readPaths ?? [];
	const writePaths = spec.writePaths ?? [];
	const denyPaths = spec.denyPaths ?? sensitiveCredentialPaths();

	const lines: string[] = [
		"(version 1)",
		"(deny default)",
		"",
		"; process bootstrap - enough to exec /bin/sh and dyld",
		"(allow process-exec*)",
		"(allow process-fork)",
		"(allow process-info*)",
		"(allow signal (target same-sandbox))",
		"(allow sysctl-read)",
		"(allow mach-lookup)",
		"(allow file-read-metadata)",
		"",
		"; read-only system surface required to run anything at all",
		`(allow file-read* ${subpaths([
			"/usr",
			"/bin",
			"/sbin",
			"/System",
			"/Library",
			"/private/etc",
			"/private/var/db",
			"/private/var/select",
			"/opt",
		])})`,
		'(allow file-read* (literal "/") (literal "/private") (literal "/tmp") (literal "/var") (literal "/etc") (literal "/dev"))',
		'(allow file-read* file-write-data file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (literal "/dev/tty"))',
		'(allow file-read* (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/autofs_nowait"))',
		"",
		"; the work dir - full read/write",
		`(allow file-read* file-write* (subpath ${sbplString(workDir)}))`,
	];

	if (writePaths.length > 0) {
		lines.push(
			"",
			"; manifest write scopes",
			`(allow file-read* file-write* ${subpaths(writePaths)})`,
		);
	}
	if (readPaths.length > 0) {
		lines.push("", "; manifest read scopes", `(allow file-read* ${subpaths(readPaths)})`);
	}

	lines.push("", "; network");
	if (spec.allowNetwork) {
		lines.push("(allow network*)", "(allow system-socket)");
	} else {
		lines.push("(deny network*)");
	}

	if (denyPaths.length > 0) {
		lines.push(
			"",
			"; sensitive credential stores - denied LAST so these rules always win",
			`(deny file-read* file-write* ${literalsAndSubpaths(denyPaths)})`,
		);
	}

	return `${lines.join("\n")}\n`;
}

// ============================================
// Capability-manifest bridge
// ============================================

/**
 * Derive a seatbelt spec from a tool's capability manifest, so the OS
 * sandbox enforces exactly the scopes the manifest declared. Returns
 * undefined when the tool has no manifest (deny by default: the caller
 * must not run it unsandboxed as a fallback).
 */
export function seatbeltSpecForTool(
	toolName: string,
	workDir: string,
	opts: { allowNetwork?: boolean } = {},
): SeatbeltSpec | undefined {
	const scopes = resolveManifestFsScopes(toolName, workDir);
	if (!scopes) return undefined;
	return {
		workDir,
		readPaths: scopes.read,
		writePaths: scopes.write,
		allowNetwork: opts.allowNetwork ?? false,
	};
}

// ============================================
// Per-session scratch dirs
// ============================================

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const SCRATCH_PREFIX = "8gent-scratch-";

function scratchPath(sessionId: string): string {
	if (!SESSION_ID_PATTERN.test(sessionId)) {
		throw new Error(
			`seatbelt: invalid session id "${sessionId}" (allowed: letters, digits, ".", "_", "-")`,
		);
	}
	return path.join(os.tmpdir(), `${SCRATCH_PREFIX}${sessionId}`);
}

/**
 * Create (or reuse) the scratch dir for a session. Exec tools in the same
 * session share it across calls; it survives until the session is destroyed,
 * unlike the per-run temp dirs of the tempdir layer.
 */
export function sessionScratchDir(sessionId: string): string {
	const dir = scratchPath(sessionId);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/** Remove a session's scratch dir and everything in it. */
export function destroySessionScratch(sessionId: string): void {
	fs.rmSync(scratchPath(sessionId), { recursive: true, force: true });
}
