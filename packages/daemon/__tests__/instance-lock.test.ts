/**
 * One daemon per data dir (governance #1123): a second daemon must refuse to
 * start, before its cron scheduler can rewrite cron.json.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_LOCK_FILE, DaemonAlreadyRunning, acquireDaemonLock } from "../instance-lock";

const made: string[] = [];
const freshDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "daemon-lock-"));
	made.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const lockOf = (dir: string) => join(dir, DAEMON_LOCK_FILE);

describe("acquireDaemonLock", () => {
	test("the first daemon takes the lock with its pid", () => {
		const dir = freshDir();
		const release = acquireDaemonLock(dir, { owner: 4242, alive: () => true });
		expect(readFileSync(lockOf(dir), "utf8").trim()).toBe("4242");
		release();
		expect(existsSync(lockOf(dir))).toBe(false);
	});

	test("a second daemon is refused while the first is alive, and names its pid", () => {
		const dir = freshDir();
		acquireDaemonLock(dir, { owner: 4242, alive: () => true });
		let err: unknown;
		try {
			acquireDaemonLock(dir, { owner: 5151, alive: (pid) => pid === 4242 });
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(DaemonAlreadyRunning);
		expect((err as DaemonAlreadyRunning).holder).toBe(4242);
		expect((err as Error).message).toContain("another 8gent daemon (pid 4242)");
		expect((err as Error).message).toContain("cron.json");
		expect(readFileSync(lockOf(dir), "utf8").trim()).toBe("4242");
	});

	test("a lock left by a dead daemon is taken over", () => {
		const dir = freshDir();
		writeFileSync(lockOf(dir), "4242\n");
		acquireDaemonLock(dir, { owner: 5151, alive: () => false });
		expect(readFileSync(lockOf(dir), "utf8").trim()).toBe("5151");
	});

	test("a lock holding our own pid is stale (container restarted as the same pid)", () => {
		const dir = freshDir();
		writeFileSync(lockOf(dir), "1\n");
		acquireDaemonLock(dir, { owner: 1, alive: () => true });
		expect(readFileSync(lockOf(dir), "utf8").trim()).toBe("1");
	});

	test("release never removes a lock another daemon now holds", () => {
		const dir = freshDir();
		const release = acquireDaemonLock(dir, { owner: 4242, alive: () => true });
		writeFileSync(lockOf(dir), "5151\n"); // taken over after we were judged dead
		release();
		expect(readFileSync(lockOf(dir), "utf8").trim()).toBe("5151");
	});
});

describe("the daemon entry refuses a second instance", () => {
	test("bun run packages/daemon/index.ts exits 1 with a clear message and writes no cron.json", () => {
		const dir = freshDir();
		// This test process is alive and is not the child: it stands in for the running daemon.
		writeFileSync(lockOf(dir), `${process.pid}\n`);
		const entry = join(import.meta.dir, "..", "index.ts");
		const run = Bun.spawnSync([process.execPath, "run", entry], {
			env: {
				...process.env,
				HOME: dir,
				EIGHT_DATA_DIR: dir,
				EIGHT_DAEMON_PORT: String(20000 + Math.floor(Math.random() * 20000)),
			},
			stdout: "pipe",
			stderr: "pipe",
			timeout: 60_000,
		});
		const stderr = run.stderr.toString();
		expect(run.exitCode).toBe(1);
		expect(stderr).toContain(`another 8gent daemon (pid ${process.pid}) already runs`);
		expect(stderr).toContain("Refusing to start a second one");
		expect(run.stdout.toString()).not.toContain("Eight Daemon starting");
		expect(existsSync(join(dir, "cron.json"))).toBe(false);
		expect(readFileSync(lockOf(dir), "utf8").trim()).toBe(String(process.pid));
	}, 90_000);
});
