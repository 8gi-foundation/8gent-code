/**
 * The local link between a daemon and the TUI on the same machine (#4834, epic #4792).
 *
 *   <dataDir>/daemon.token  the operator token: 64 hex chars, mode 0600, owner only.
 *   <dataDir>/daemon.json   where this daemon listens: { url, pid, dataDir }. No token.
 *
 * Both files are read through one check: a regular file (never a symlink), owned
 * by this user, no group or other bits. Anything else is treated as absent, so a
 * planted or loosened file can never hand out, or redirect, the token. The token
 * is never logged and never put in a URL.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const TOKEN_FILE = "daemon.token";
export const DISCOVERY_FILE = "daemon.json";
const TOKEN_RE = /^[0-9a-f]{64}$/;

export interface Discovery {
	url: string;
	pid: number;
	dataDir: string;
}

/** Why a file is not safe to trust, or null when it is. Does not follow symlinks. */
function unsafeReason(file: string): string | null {
	let st: fs.Stats;
	try {
		st = fs.lstatSync(file);
	} catch {
		return "missing";
	}
	if (st.isSymbolicLink()) return "is a symlink";
	if (!st.isFile()) return "is not a regular file";
	if (process.platform !== "win32") {
		if ((st.mode & 0o077) !== 0) return "is readable by other users (mode must be 0600)";
		if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
			return "is owned by another user";
		}
	}
	return null;
}

function readTrusted(file: string): string | null {
	if (unsafeReason(file) !== null) return null;
	try {
		return fs.readFileSync(file, "utf8").trim();
	} catch {
		return null;
	}
}

/** The operator token in `dir`, or null when absent, malformed or unsafe. */
export function readTokenFile(dir: string): string | null {
	const t = readTrusted(path.join(dir, TOKEN_FILE));
	return t && TOKEN_RE.test(t) ? t : null;
}

/**
 * The operator token in `dir`, creating it (0600, in a 0700 directory when the
 * directory is new) on first use. Throws, never overwrites, when a file is in the
 * way that is unsafe or malformed: the caller fails closed (no operator token).
 */
export function ensureTokenFile(dir: string): string {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, TOKEN_FILE);
	const existing = readTokenFile(dir);
	if (existing) return existing;
	const why = unsafeReason(file);
	if (why !== "missing") throw new Error(`${TOKEN_FILE} ${why ?? "is malformed"}; not using it`);
	const token = randomBytes(32).toString("hex");
	fs.writeFileSync(file, `${token}\n`, { flag: "wx", mode: 0o600 });
	return token;
}

/** Write daemon.json atomically with mode 0600. */
export function writeDiscovery(dir: string, d: Discovery): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, DISCOVERY_FILE);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(d)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/** Remove daemon.json, but only if it is this process's own. */
export function removeDiscovery(dir: string, pid = process.pid): void {
	const found = readDiscovery(dir, { requireLive: false });
	if (found?.pid !== pid) return;
	try {
		fs.unlinkSync(path.join(dir, DISCOVERY_FILE));
	} catch {}
}

function isLoopbackWsUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return (
			(u.protocol === "ws:" || u.protocol === "wss:") &&
			["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) &&
			!u.username &&
			!u.password
		);
	} catch {
		return false;
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM means the process exists but is not ours: still alive.
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The daemon.json in `dir`: safe file, well-formed, a loopback url, and (by default) a live pid. */
export function readDiscovery(dir: string, opts: { requireLive?: boolean } = {}): Discovery | null {
	const raw = readTrusted(path.join(dir, DISCOVERY_FILE));
	if (!raw) return null;
	try {
		const d = JSON.parse(raw) as Partial<Discovery>;
		if (typeof d.url !== "string" || !isLoopbackWsUrl(d.url)) return null;
		if (!Number.isInteger(d.pid) || (d.pid as number) <= 0) return null;
		if (typeof d.dataDir !== "string") return null;
		if (opts.requireLive !== false && !alive(d.pid as number)) return null;
		return { url: d.url, pid: d.pid as number, dataDir: d.dataDir };
	} catch {
		return null;
	}
}

/** Live local daemons: `<home>/.8gent/daemon.json`, then `<home>/.8gent/*\/daemon.json`, with their directories. */
export function discoverDaemons(home: string): Array<Discovery & { dir: string }> {
	const root = path.join(home, ".8gent");
	const dirs = [root];
	try {
		for (const e of fs
			.readdirSync(root, { withFileTypes: true })
			.sort((a, b) => a.name.localeCompare(b.name))) {
			if (e.isDirectory()) dirs.push(path.join(root, e.name));
		}
	} catch {}
	const out: Array<Discovery & { dir: string }> = [];
	for (const dir of dirs) {
		const d = readDiscovery(dir);
		if (d) out.push({ ...d, dir });
	}
	return out;
}
