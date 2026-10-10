/**
 * Removing a SQLite file (or a directory holding one) in a test (#3814).
 *
 * POSIX lets you unlink a file that is still open. Windows answers EBUSY.
 * bun:sqlite's db.close() is sqlite3_close_v2, which keeps the file open
 * until every prepared statement is finalized, and statements are finalized
 * by the garbage collector. So a test that closes its db and deletes the
 * file straight away can hit EBUSY on Windows only. These helpers collect
 * garbage and retry briefly; on POSIX the first attempt succeeds, so they
 * cost nothing there.
 */
import { existsSync, rmSync, unlinkSync } from "node:fs";

const ATTEMPTS = 40;
const WAIT_MS = 50;

function pause(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function retryBusy(op: () => void): void {
	for (let i = 0; ; i++) {
		try {
			op();
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if ((code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") || i >= ATTEMPTS) throw err;
			Bun.gc(true);
			pause(WAIT_MS);
		}
	}
}

/** Delete a SQLite file plus its -wal and -shm siblings, waiting out a lingering handle. */
export function removeDbFiles(dbPath: string): void {
	for (const suffix of ["", "-wal", "-shm"]) {
		const p = dbPath + suffix;
		if (existsSync(p)) retryBusy(() => unlinkSync(p));
	}
}

/** rmSync(recursive, force) that waits out a lingering SQLite handle on Windows. */
export function removeTree(dir: string): void {
	retryBusy(() => rmSync(dir, { recursive: true, force: true }));
}
