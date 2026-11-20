/**
 * Owner-only file modes for a memory database on disk.
 *
 * Session files are written 0600 in a 0700 folder (packages/eight/session-store.ts).
 * /history search copies every turn into memory.db, so the db and its WAL
 * sidecars must be at least as private: 0600 for <db>, <db>-wal and <db>-shm,
 * 0700 for the folder that holds them. Existing files and folders are
 * tightened too, so an older install that left them 0644 / 0755 is fixed on
 * the next open.
 *
 * Skipped for in-memory and URI paths, on Windows (POSIX modes do not apply),
 * and never applied to the home folder, the temp folder or the root.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DB_FILE_MODE = 0o600;
export const DB_DIR_MODE = 0o700;

function isOnDisk(dbPath: string): boolean {
	return dbPath !== "" && dbPath !== ":memory:" && !dbPath.startsWith("file:");
}

function setModeIfDifferent(p: string, mode: number): void {
	try {
		const st = fs.statSync(p);
		if ((st.mode & 0o777) !== mode) fs.chmodSync(p, mode);
	} catch {
		// absent, or not ours to change; the open that follows reports real errors
	}
}

function isSharedFolder(dir: string): boolean {
	const shared = [os.homedir(), os.tmpdir(), path.parse(dir).root].map((d) => path.resolve(d));
	return shared.includes(path.resolve(dir));
}

/** Before the open: make the folder 0700 and the db file 0600, creating them if needed. */
export function prepareDbFile(dbPath: string): void {
	if (process.platform === "win32" || !isOnDisk(dbPath)) return;
	const dir = path.dirname(path.resolve(dbPath));
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: DB_DIR_MODE });
	if (!isSharedFolder(dir)) setModeIfDifferent(dir, DB_DIR_MODE);
	// SQLite creates -wal and -shm with the main file's mode, so the main file goes first.
	if (!fs.existsSync(dbPath)) fs.closeSync(fs.openSync(dbPath, "a", DB_FILE_MODE));
	tightenDbFiles(dbPath);
}

/** After WAL is on: the db and any sidecars already on disk go to 0600. */
export function tightenDbFiles(dbPath: string): void {
	if (process.platform === "win32" || !isOnDisk(dbPath)) return;
	for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
		setModeIfDifferent(f, DB_FILE_MODE);
	}
}
