/**
 * Durable run storage: one SQLite file under the 8gent data folder, mode 0600 (#4883).
 * The file is created private before SQLite opens it, so its -wal and -shm files inherit 0600,
 * and an older file with looser bits is tightened. Pi Durable (MIT, earendil-works/pi) owns the
 * tables; the effect ledger lives beside them in the same file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

/** A run id becomes a file name: letters, digits, `_` and `-` only, so it can never name another path. */
export const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function defaultRunDb(runId: string): string {
	if (!RUN_ID_RE.test(runId))
		throw new Error(`not a valid run id: ${JSON.stringify(runId).slice(0, 60)}`);
	const base = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
	return path.join(base, "runs", `${runId}.sqlite`);
}

/**
 * Create or tighten the file: 0600, regular files only, never through a link. A folder this
 * creates is 0700. An existing folder is never re-moded (`8gent durable-run ~` must not chmod
 * the home folder): it must be this user's and not writable by anyone else, or it is refused.
 */
export function preparePrivateFile(file: string): void {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const st = fs.statSync(dir);
	if (!st.isDirectory()) throw new Error(`not a folder: ${dir}`);
	if (typeof process.getuid === "function" && st.uid !== process.getuid())
		throw new Error(`folder is not yours: ${dir}`);
	if (st.mode & 0o022)
		throw new Error(`folder is writable by others, refusing to keep a run in it: ${dir}`);
	const fd = fs.openSync(
		file,
		fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
		0o600,
	);
	try {
		if (!fs.fstatSync(fd).isFile()) throw new Error(`not a regular file: ${file}`);
		fs.fchmodSync(fd, 0o600);
	} finally {
		fs.closeSync(fd);
	}
}

export async function openRunDatabase(file: string): Promise<SqliteDatabase> {
	preparePrivateFile(file);
	return openNodeSqliteDatabase(file);
}

export async function openRunStorage(
	file: string,
	wrap: (db: SqliteDatabase) => SqliteDatabase = (d) => d,
): Promise<SqliteStorage> {
	return SqliteStorage.open(wrap(await openRunDatabase(file)));
}
