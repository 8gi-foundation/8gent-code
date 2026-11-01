/**
 * Per-session scratch directory: the one writable place outside the workspace
 * (#4488). Policy (policy-engine.ts), the sandbox work dir (seatbelt.ts) and
 * run_command overflow output (toolshed run.ts) all use this single helper, so
 * they agree on one verified 0700 directory.
 *
 * Layout: <data dir>/scratch/<sanitised id, max 32>-<sha256(raw id)[0..16]>.
 * Fail closed: if the data dir, `scratch/` or the session dir is a symlink, is
 * owned by someone else, or the session dir cannot be made 0700, the helper
 * returns null and callers must not allow anything.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveHome } from "../core/home.js";

/** One random token per process: the key for sessions that carry no id. */
const PROCESS_TOKEN = crypto.randomUUID();

const verified = new Map<string, string>();

function dataDir(): string {
	return process.env.EIGHT_DATA_DIR || path.join(resolveHome(), ".8gent");
}

/** Directory name for a session id. Pure; distinct raw ids never share a name. */
export function scratchKey(sessionId?: unknown): string {
	if (typeof sessionId !== "string" || !sessionId) return `proc-${PROCESS_TOKEN}`;
	const prefix = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
	const digest = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
	return `${prefix}-${digest}`;
}

/** Where the scratch dir lives. Pure: touches no filesystem. */
export function scratchDirPath(sessionId?: unknown): string {
	return path.join(dataDir(), "scratch", scratchKey(sessionId));
}

function isOwnRealDir(p: string): boolean {
	const st = fs.lstatSync(p);
	if (st.isSymbolicLink() || !st.isDirectory()) return false;
	if (process.platform === "win32") return true;
	return typeof process.getuid !== "function" || st.uid === process.getuid();
}

/** A parent we rely on: own real dir that neither group nor world can write. */
function isTrustedParent(p: string): boolean {
	if (!isOwnRealDir(p)) return false;
	return process.platform === "win32" || (fs.lstatSync(p).mode & 0o022) === 0;
}

/** Make a directory, tolerating "already exists"; the caller verifies it afterwards. */
function mkdirOnce(p: string): void {
	try {
		fs.mkdirSync(p, { mode: 0o700 });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
}

/** Force 0700 on the session dir through an fd opened O_NOFOLLOW, so a swapped-in symlink is never chmodded. */
function tightenNoFollow(dir: string): void {
	const flags =
		fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_DIRECTORY ?? 0);
	const fd = fs.openSync(dir, flags);
	try {
		const st = fs.fstatSync(fd);
		if (
			!st.isDirectory() ||
			(typeof process.getuid === "function" && st.uid !== process.getuid())
		) {
			throw new Error(`not an owned real directory: ${dir}`);
		}
		if ((st.mode & 0o777) !== 0o700) fs.fchmodSync(fd, 0o700);
		if ((fs.fstatSync(fd).mode & 0o777) !== 0o700) throw new Error(`cannot set 0700: ${dir}`);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Create a new file inside a scratch dir without ever following a planted
 * symlink: O_EXCL (fails if anything, including a symlink, already holds the
 * name) plus O_NOFOLLOW, mode 0600. Throws on any failure; callers fall back.
 */
export function writeScratchFileExclusive(dir: string, name: string, data: string): string {
	const file = path.join(dir, name);
	const fd = fs.openSync(
		file,
		fs.constants.O_WRONLY |
			fs.constants.O_CREAT |
			fs.constants.O_EXCL |
			(fs.constants.O_NOFOLLOW ?? 0),
		0o600,
	);
	try {
		fs.writeSync(fd, data);
	} finally {
		fs.closeSync(fd);
	}
	return file;
}

/** Save overflow output under an unguessable name; null when it cannot be saved safely. */
export function saveScratchOverflow(dir: string, data: string): string | null {
	try {
		return writeScratchFileExclusive(dir, `cmd-${crypto.randomUUID()}.txt`, data);
	} catch {
		return null;
	}
}

/**
 * Create (if needed) and verify the session scratch dir; return its realpath,
 * or null when any check fails. Re-verified cheaply on every call so a dir that
 * vanished or was swapped for a symlink is never trusted from cache.
 */
export function policyScratchDir(sessionId?: unknown): string | null {
	const dir = scratchDirPath(sessionId);
	const cached = verified.get(dir);
	if (cached) {
		try {
			if (isOwnRealDir(cached)) return cached;
		} catch {}
		verified.delete(dir);
	}
	try {
		const data = dataDir();
		const scratch = path.dirname(dir);
		// Check each level before creating anything inside it, so a refused
		// parent never gets a child created in its target.
		fs.mkdirSync(data, { recursive: true, mode: 0o700 });
		if (!isTrustedParent(data))
			throw new Error(`untrusted directory (not owned, symlink or group/world writable): ${data}`);
		mkdirOnce(scratch);
		if (!isTrustedParent(scratch))
			throw new Error(
				`untrusted directory (not owned, symlink or group/world writable): ${scratch}`,
			);
		mkdirOnce(dir);
		if (!isOwnRealDir(dir)) throw new Error(`not an owned real directory: ${dir}`);
		if (process.platform !== "win32") tightenNoFollow(dir);
		const real = fs.realpathSync(dir);
		verified.set(dir, real);
		return real;
	} catch (err) {
		console.warn(`[session-scratch] refusing scratch dir ${dir}: ${(err as Error).message}`);
		return null;
	}
}
