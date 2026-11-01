/**
 * Remove a test directory, retrying while Windows still holds it.
 *
 * Windows refuses to delete a file or folder something has open (EBUSY, EPERM,
 * ENOTEMPTY), where POSIX unlinks it at once. A handle that a finished test
 * released a moment ago (a closed SQLite file whose statements await
 * collection, a child process still exiting) frees up shortly after, so a
 * short retry with a GC pass clears it. Any other error, and a lock that
 * outlives the retries, still throws: the test must not hide a real leak.
 */
import { rmSync } from "node:fs";

const RETRYABLE = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

export function rmRetry(target: string, attempts = 20, delayMs = 100): void {
	for (let i = 0; ; i++) {
		try {
			rmSync(target, { recursive: true, force: true });
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? "";
			if (!RETRYABLE.has(code) || i >= attempts) throw err;
			Bun.gc(true);
			Bun.sleepSync(delayMs);
		}
	}
}
