/**
 * @8gent/terminal-tab — session-store.ts
 *
 * Persistence for window-spawned terminal sessions. When `/term claude
 * --window` opens a Terminal.app window, we write the session metadata
 * here so that:
 *   - the TUI can reconnect on restart (don't orphan running CLIs)
 *   - users can list / kill / focus their windows from any 8gent tab
 *   - the orchestration layer has an audit trail of what's running
 *
 * Storage layout (one file per session):
 *   ~/.8gent/sessions/<sessionId>.json
 *
 * The store is purposely just JSON-on-disk — no SQLite, no daemon. The
 * Terminal.app window is the source of truth for liveness; we use
 * `kill -0 <pid>` to verify a session is still alive on read.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WindowSession {
	sessionId: string;
	command: string;
	args: string[];
	label: string;
	pid: number;
	cwd: string;
	startedAt: string; // ISO timestamp
	/** "preset" | "shell" | "raw" — same as ResolvedTermCommand.source */
	source: "preset" | "shell" | "raw";
	/** Optional Terminal.app window/tab ids for focus calls. */
	windowId?: string;
	tabIndex?: number;
}

export const DEFAULT_DIR = join(homedir(), ".8gent", "sessions");

function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * `kill -0 <pid>` returns:
 *   - success: process exists (you may or may not have permission to signal)
 *   - EPERM: process exists but you can't signal it (still "alive")
 *   - ESRCH: process does not exist (dead)
 * We treat EPERM as alive — same as `ps`.
 */
export function isPidAlive(pid: number): boolean {
	if (!pid || pid < 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return code === "EPERM";
	}
}

export function saveSession(session: WindowSession, dir: string = DEFAULT_DIR): void {
	ensureDir(dir);
	const path = join(dir, `${session.sessionId}.json`);
	writeFileSync(path, JSON.stringify(session, null, 2), "utf-8");
}

export function getSession(sessionId: string, dir: string = DEFAULT_DIR): WindowSession | null {
	const path = join(dir, `${sessionId}.json`);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as WindowSession;
	} catch {
		return null;
	}
}

export function loadSessions(dir: string = DEFAULT_DIR): WindowSession[] {
	if (!existsSync(dir)) return [];
	const out: WindowSession[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		try {
			const raw = readFileSync(join(dir, file), "utf-8");
			const session = JSON.parse(raw) as WindowSession;
			if (session && typeof session.sessionId === "string") out.push(session);
		} catch {
			// skip malformed files
		}
	}
	return out;
}

export function deleteSession(sessionId: string, dir: string = DEFAULT_DIR): void {
	const path = join(dir, `${sessionId}.json`);
	if (existsSync(path)) {
		try {
			rmSync(path, { force: true });
		} catch {
			/* best-effort */
		}
	}
}

/**
 * Walk all session files, drop ones whose pid is no longer alive,
 * and return the remaining live sessions. Called at TUI boot.
 */
export function pruneDead(dir: string = DEFAULT_DIR): WindowSession[] {
	const all = loadSessions(dir);
	const live: WindowSession[] = [];
	for (const s of all) {
		if (isPidAlive(s.pid)) {
			live.push(s);
		} else {
			deleteSession(s.sessionId, dir);
		}
	}
	return live;
}
