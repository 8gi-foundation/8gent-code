/**
 * Test preload (bunfig.toml [test].preload, listed FIRST): the run's temp
 * files live in one run-scoped directory, removed after the run, and the run
 * fails if a fixed test starts leaking again (#3285).
 *
 * Test suites left about 24k directories and 11 GB in $TMPDIR, which pushed
 * the Mac CI runner below its 12 GB disk floor. So:
 *
 *  1. TMPDIR, TEMP and TMP all point at a fresh `8gent-test-tmp-<pid>-*`
 *     directory for the whole run (os.tmpdir() reads TMPDIR on POSIX and
 *     TEMP/TMP on Windows, on every call), and child processes inherit them,
 *     so everything the run writes to "temp" lands in here. If os.tmpdir()
 *     still does not answer the run dir, the guard says once that it is
 *     inactive instead of passing silently.
 *  2. After the run, the guard lists what is still in that directory. An entry
 *     whose name starts with a GUARDED prefix (temp-guard.ts) fails the run:
 *     that test was fixed to clean up after itself and has regressed. Other
 *     leftovers are reported in one line, not failed, until their tests are
 *     fixed too.
 *  3. The run directory is removed either way, so nothing outlives the run.
 *  4. At startup, run dirs from interrupted runs (owning pid dead, older than
 *     STALE_AFTER_MS) are removed. Nothing else in the temp folder is touched.
 *
 * The guard is scoped to this run's own directory, so a second suite running
 * on the same machine can never trip it. A test that calls process.exit()
 * ends the run before any afterAll, so it bypasses the guard and the cleanup.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanupTempDirs } from "./temp-dirs";
import { RUN_DIR_PREFIX, leftovers, staleRunDirs } from "./temp-guard";

const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

const parent = resolve(tmpdir());
for (const name of staleRunDirs(parent, Date.now(), STALE_AFTER_MS)) {
	try {
		rmSync(join(parent, name), { recursive: true, force: true });
	} catch {}
}

const runTmp = mkdtempSync(join(parent, `${RUN_DIR_PREFIX}${process.pid}-`));
process.env.TMPDIR = runTmp;
process.env.TEMP = runTmp;
process.env.TMP = runTmp;
const active = resolve(tmpdir()) === resolve(runTmp);
if (!active) {
	console.warn(
		`[temp-dirs] guard INACTIVE: os.tmpdir() is ${tmpdir()}, not the run dir ${runTmp}. Temp leaks are not checked on this platform.`,
	);
}

afterAll(() => {
	cleanupTempDirs();
	const { guarded, other } = active ? leftovers(runTmp) : { guarded: [], other: [] };
	// Best effort: a cleanup error (seen as EIO on a full CI disk) must not hide the guard result.
	try {
		rmSync(runTmp, { recursive: true, force: true });
	} catch {}
	if (!active) return;
	console.warn(
		`[temp-dirs] guard active: ${guarded.length} guarded leaks, ${other.length} other temp entries left by tests not yet fixed (#3285), removed with the run dir${other.length > 0 ? `: ${other.slice(0, 20).join(", ")}${other.length > 20 ? ", ..." : ""}` : ""}`,
	);
	if (guarded.length > 0) {
		throw new Error(
			`[temp-dirs] ${guarded.length} temp dirs leaked by tests that must clean up, or cleanupTempDirs() failed (#3285): ${guarded.slice(0, 20).join(", ")}. Make them with tempDir() from tests/temp-dirs.ts and add afterAll(cleanupTempDirs).`,
		);
	}
});
