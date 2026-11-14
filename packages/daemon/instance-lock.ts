/**
 * One daemon per data dir (governance #1123).
 *
 * The daemon keeps its cron jobs in memory and rewrites <dataDir>/cron.json on
 * every save, so two daemons on one data dir undo each other's jobs. On 13 Nov
 * a copy started outside launchd did exactly that. The port probe in
 * `8gent daemon run` does not cover it: `bun run packages/daemon/index.ts`
 * skips that probe, and main() builds the pool and cron long before the bind.
 *
 * So main() takes <dataDir>/daemon.lock first, before anything else starts.
 * The lock is the pid file the work queue already uses (queue.ts acquireLock):
 * created atomically, and a lock whose pid is dead is stale and taken over, so
 * a crash or kill -9 never wedges the next start.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type LockOptions, acquireLock } from "./queue";

export const DAEMON_LOCK_FILE = "daemon.lock";

export class DaemonAlreadyRunning extends Error {
	constructor(
		readonly lockPath: string,
		readonly holder: number | null,
	) {
		const who = holder ? `pid ${holder}` : "another process";
		super(
			`another 8gent daemon (${who}) already runs on this data dir (${lockPath}). Refusing to start a second one: two daemons overwrite each other's cron.json. Check it with \`8gent daemon status\`. If ${who} is not an 8gent daemon, delete ${lockPath} and start again.`,
		);
		this.name = "DaemonAlreadyRunning";
	}
}

function lockHolder(lockPath: string): number | null {
	try {
		const pid = Number.parseInt(readFileSync(lockPath, "utf8"), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Take the data dir's daemon lock or throw DaemonAlreadyRunning. Returns a
 * release function that removes the lock only while it still holds our pid.
 *
 * A lock holding our own pid is stale: in a container the daemon is often pid 1
 * on every boot, and the lock on the volume still says 1 from the last boot.
 */
export function acquireDaemonLock(dataDir: string, opts: LockOptions = {}): () => void {
	const lockPath = join(dataDir, DAEMON_LOCK_FILE);
	const owner = opts.owner ?? process.pid;
	const alive = opts.alive ?? pidAlive;
	try {
		acquireLock(lockPath, { ...opts, owner, alive: (pid) => pid !== owner && alive(pid) });
	} catch (err) {
		// acquireLock throws "... is locked by pid N ..." for a live holder; any other
		// failure (a permission error, say) is passed through as it is.
		if (!/ is locked by pid /.test((err as Error).message)) throw err;
		throw new DaemonAlreadyRunning(lockPath, lockHolder(lockPath));
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (lockHolder(lockPath) !== owner) return;
		try {
			unlinkSync(lockPath);
		} catch {}
	};
}
