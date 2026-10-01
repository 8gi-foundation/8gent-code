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
