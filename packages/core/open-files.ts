import * as fs from "node:fs";

/**
 * Does this process still hold `file` open?
 *
 * Test support for the Windows file-locking rules: on Windows an open file
 * cannot be deleted or renamed, while Linux and macOS allow both, so a leaked
 * handle only shows up as EBUSY on a Windows runner. This asks the OS
 * directly on every platform, so a leak fails the test on Linux and macOS too.
 *
 *   linux:  scan /proc/self/fd
 *   darwin: lsof on our own pid
 *   win32:  try to rename the file away and back (fails while it is open)
 */
export function isOpenByThisProcess(file: string): boolean {
	if (!fs.existsSync(file)) return false;
	const real = fs.realpathSync(file);

	if (process.platform === "win32") {
		const probe = `${file}.open-probe`;
		try {
			fs.renameSync(file, probe);
		} catch {
			return true;
		}
		fs.renameSync(probe, file);
		return false;
	}

	if (process.platform === "linux") {
		for (const fd of fs.readdirSync("/proc/self/fd")) {
			try {
				if (fs.readlinkSync(`/proc/self/fd/${fd}`) === real) return true;
			} catch {
				// fd closed while we were listing
			}
		}
		return false;
	}

	const out = Bun.spawnSync(["lsof", "-Fn", "-p", String(process.pid)]).stdout.toString();
	return out.split("\n").some((line) => line.startsWith("n") && line.slice(1) === real);
}

/**
 * rmSync(path, { recursive, force }) that waits out a brief Windows lock.
 *
 * On windows-latest a directory a test has just written to can stay locked
 * for about 100 ms after every handle in this process is closed (the probe
 * above finds no open file in it, and a retry 100 ms later succeeds). Linux
 * and macOS never hit this. bun's rmSync ignores maxRetries, so the retry is
 * done here: up to `timeoutMs`, only for EBUSY, EPERM and ENOTEMPTY, and the
 * last error is rethrown so a lock that does not clear still fails the test.
 */
export function removeWhenReleased(target: string, timeoutMs = 3000): void {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			fs.rmSync(target, { recursive: true, force: true });
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			const transient = code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
			if (!transient || Date.now() >= deadline) throw err;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
		}
	}
}
