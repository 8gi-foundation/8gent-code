/**
 * TEST SUPPORT ONLY. Nothing in product code may import this module: it
 * shells out to lsof on macOS, renames files on Windows and blocks the thread
 * while retrying. It lives in packages/core so tests in every package can
 * reach it with a relative import.
 */
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
 *
 * The Windows probe cannot tell whose handle it is: a file held open by ANY
 * process (an antivirus scan, another test worker) reads as open. On Linux
 * and macOS the answer is about this process only.
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
		try {
			fs.renameSync(probe, file);
		} catch (err) {
			// Something grabbed the original name in between. Say so loudly:
			// the file now lives at the probe path.
			throw new Error(`isOpenByThisProcess: could not rename ${probe} back to ${file}: ${err}`);
		}
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
 * done here: up to `timeoutMs`, only for EBUSY, ENOTEMPTY and (on Windows)
 * EPERM. The last error is rethrown, so a lock that does not clear still
 * fails the test.
 */
export function removeWhenReleased(target: string, timeoutMs = 3000): void {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		try {
			fs.rmSync(target, { recursive: true, force: true });
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			// EPERM is how Windows reports a pending delete; elsewhere it is a
			// real permission error and must fail at once.
			const transient =
				code === "EBUSY" ||
				code === "ENOTEMPTY" ||
				(code === "EPERM" && process.platform === "win32");
			if (!transient || performance.now() >= deadline) throw err;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
		}
	}
}
