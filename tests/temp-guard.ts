/**
 * The pure parts of the temp-dir guard (#3285), kept apart from
 * preload-temp-dirs.ts so they can be tested without its side effects.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Prefixes whose tests now clean up (#3285). Add a prefix here when its
 * test is fixed; a leftover with one of these names fails the run.
 */
export const GUARDED_PREFIXES: readonly string[] = [
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

/** The home preload (preload-temp-home.ts) makes its own dir in the run dir and removes it. */
export const IGNORED_PREFIXES: readonly string[] = ["8gent-test-home-"];

/** Run dirs are named `8gent-test-tmp-<pid>-XXXXXX`. */
export const RUN_DIR_PREFIX = "8gent-test-tmp-";
const RUN_DIR_RE = /^8gent-test-tmp-(\d+)-[^-]+$/;

/** What is still in a run dir, split into guarded leaks and the rest. Ignored names are left out. */
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

/** True when a process with this pid exists (EPERM means it exists but is not ours). */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Run dirs in `parent` left by an interrupted run: the owning pid is dead and
 * the dir is older than `maxAgeMs`. Never the current process's own dir, and
 * never anything not named like a run dir.
 */
export function staleRunDirs(
	parent: string,
	now: number,
	maxAgeMs: number,
	isAlive: (pid: number) => boolean = pidAlive,
): string[] {
	let names: string[] = [];
	try {
		names = readdirSync(parent);
	} catch {
		return [];
	}
	const stale: string[] = [];
	for (const name of names) {
		const m = RUN_DIR_RE.exec(name);
		if (!m) continue;
		const pid = Number(m[1]);
		if (pid === process.pid || isAlive(pid)) continue;
		try {
			if (now - statSync(join(parent, name)).mtimeMs < maxAgeMs) continue;
		} catch {
			continue;
		}
		stale.push(name);
	}
	return stale.sort();
}
