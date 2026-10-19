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
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		for (const p of [dataDir(), path.dirname(dir), dir]) {
			if (!isOwnRealDir(p)) throw new Error(`not an owned real directory: ${p}`);
		}
		if (process.platform !== "win32" && (fs.lstatSync(dir).mode & 0o777) !== 0o700) {
			fs.chmodSync(dir, 0o700);
			if ((fs.lstatSync(dir).mode & 0o777) !== 0o700) throw new Error(`cannot set 0700: ${dir}`);
		}
		const real = fs.realpathSync(dir);
		verified.set(dir, real);
		return real;
	} catch (err) {
		console.warn(`[session-scratch] refusing scratch dir ${dir}: ${(err as Error).message}`);
		return null;
	}
}
