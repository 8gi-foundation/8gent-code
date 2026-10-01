/**
 * Test preload (bunfig.toml [test].preload, listed FIRST): the run's temp
 * files live in one run-scoped directory, removed after the run, and the run
 * fails if a fixed test starts leaking again (#3285).
 *
 * Test suites left about 24k directories and 11 GB in $TMPDIR, which pushed
 * the Mac CI runner below its 12 GB disk floor. So:
 *
 *  1. $TMPDIR points at a fresh `8gent-test-tmp-*` directory for the whole run.
 *     os.tmpdir() reads $TMPDIR on every call and child processes inherit it,
 *     so everything the run writes to "temp" lands in here, including folders
 *     made by tools the tests spawn.
 *  2. After the run, the guard lists what is still in that directory. An entry
 *     whose name starts with a GUARDED prefix fails the run: that test was
 *     fixed to clean up after itself and has regressed. Other leftovers are
 *     reported as one line, not failed, until their tests are fixed too.
 *  3. The run directory is removed either way, so nothing outlives the run.
 *
 * The guard is scoped to this run's own directory, so a second suite running
 * on the same machine can never trip it.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDirs } from "./temp-dirs";

/**
 * Prefixes whose tests now clean up (#3285). Add a prefix here when its
 * test is fixed; a leftover with one of these names fails the run.
 */
export const GUARDED_PREFIXES = [
	"sys1-",
	"s1-rm-",
	"s1-own-",
	"s1-allow-nocal-",
	"subagent-guards-",
	"perm-mode-",
	"open-on-write-",
	"open-stub-",
	"bashgate-exec-",
	"lesson-collector-",
	"lesson-sources-",
	"trace-capture-",
	"local-delegation-",
];

// The home preload (preload-temp-home.ts) makes its own dir in here and removes it.
const IGNORED_PREFIXES = ["8gent-test-home-"];

const runTmp = mkdtempSync(join(tmpdir(), "8gent-test-tmp-"));
process.env.TMPDIR = runTmp;

/** What is still in the run directory, split into guarded leaks and the rest. */
export function leftovers(dir: string): { guarded: string[]; other: string[] } {
	let names: string[] = [];
	try {
		names = readdirSync(dir);
	} catch {
		return { guarded: [], other: [] };
	}
	const guarded: string[] = [];
	const other: string[] = [];
	for (const name of names) {
		if (IGNORED_PREFIXES.some((p) => name.startsWith(p))) continue;
		(GUARDED_PREFIXES.some((p) => name.startsWith(p)) ? guarded : other).push(name);
	}
	return { guarded: guarded.sort(), other: other.sort() };
}

afterAll(() => {
	cleanupTempDirs();
	const { guarded, other } = leftovers(runTmp);
	if (other.length > 0) {
		console.warn(
			`[temp-dirs] ${other.length} temp entries left by tests not yet fixed (#3285), removed with the run dir: ${other.slice(0, 20).join(", ")}${other.length > 20 ? ", ..." : ""}`,
		);
	}
	// Best effort: a cleanup error (seen as EIO on a full CI disk) must not hide the guard result.
	try {
		rmSync(runTmp, { recursive: true, force: true });
	} catch {}
	if (guarded.length > 0) {
		throw new Error(
			`[temp-dirs] ${guarded.length} temp dirs leaked by tests that must clean up (#3285): ${guarded.slice(0, 20).join(", ")}. Make them with tempDir() from tests/temp-dirs.ts and add afterAll(cleanupTempDirs).`,
		);
	}
});
