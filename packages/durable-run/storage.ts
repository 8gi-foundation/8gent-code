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

export function defaultRunDb(runId: string): string {
	const base = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
	return path.join(base, "runs", `${runId}.sqlite`);
}

/** Create or tighten the file and its folder: 0700 folder, 0600 file, regular files only. */
export function preparePrivateFile(file: string): void {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);
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
