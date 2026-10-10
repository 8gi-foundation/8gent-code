/**
 * Removing a SQLite file (or a directory holding one) in a test (#3814).
 *
 * POSIX lets you unlink a file that is still open. Windows answers EBUSY.
 * Stores close their databases through trackStatements() (packages/memory/
 * tracked-db.ts) so the file is released at close(). These helpers only add a
 * short bounded retry for the moment Windows takes to let go (antivirus, the
 * kernel closing the handle). No forced GC. On POSIX the first attempt wins.
 */
import { existsSync, rmSync, unlinkSync } from "node:fs";

const ATTEMPTS = 10;
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
			if ((code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") || i >= ATTEMPTS)
				throw err;
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
