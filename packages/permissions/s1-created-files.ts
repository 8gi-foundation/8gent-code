/**
 * System One: the files this session created (#3177).
 *
 * The pilot makes scratch files (`bun test > bunout.txt`) and then removes
 * them (`rm -f bunout.txt`). That rm fires rule rm_non_temp, so it went to the
 * judge. An agent removing a file it made itself a moment ago is not the risk
 * the judge is there for, so the gate lets it through without the judge when
 * this record says the session created the file (see s1-rm-nothing.ts for
 * every other condition).
 *
 * What counts as "created by this session":
 *   - write_file writing a path that did not exist just before the write;
 *   - a run_command whose `>` / `>>` redirect names a plain relative path that
 *     did not exist just before the command and is, after it, still the file
 *     created for it then (see "pinned" below).
 * Both tool paths (packages/eight/tools.ts, packages/ai/tools.ts) record into
 * the same object: one per ToolExecutor, which the Agent also hands to its
 * native tool context. A different agent, tab or child has its own record.
 *
 * In memory only, never written to disk. Each entry keeps the file's identity
 * (device, inode, change and birth time, size), so a file that was since
 * replaced or changed by something else no longer counts. The session's own
 * later writes to a recorded file (write_file, edit_file, a redirect) refresh
 * the entry.
 *
 * A file that existed before the session wrote to it is never recorded: an
 * overwrite or a `>` truncation of a pre-existing file is a modification, not
 * a creation.
 *
 * Redirect targets are pinned. Invariant: a redirect target is recorded only
 * if, when the command ends, the path names the very inode this module
 * created for it before the command started. Before the command runs, each
 * absent target whose parent directory resolves inside the working directory
 * is created empty with O_EXCL, and its device and inode are kept while the
 * descriptor stays open (so the inode cannot be reused). The shell's `>` and
 * `>>` open that inode; anything that puts a different inode at the path
 * leaves it unrecorded. A recorded target is refreshed only if it is still
 * the same inode, and forgotten otherwise. Commands whose effect on the
 * target's contents cannot be attributed to the redirect alone record
 * nothing: any command a rule escalates or blocks, and any command that
 * changes directory (its relative targets would resolve elsewhere).
 *
 * Effects of pre-creating: the target exists, empty, from just before the
 * command starts, so a test such as `[ -e target ]` inside the command sees
 * it; and a redirect the shell never opens (a branch not taken, or a command
 * that fails before it) leaves that empty file behind.
 *
 * Files a command's child processes create (#4159). The pilot's
 * `bash video/build_slides.sh` ran ImageMagick, which wrote
 * video/body_1-0.png and video/body_1-1.png; no redirect named them, so the
 * later `rm -f video/body_1-0.png video/body_1-1.png` went to the judge and
 * was blocked. `watchBorn` records them. Invariant: a path is recorded only
 * if ALL hold:
 *   - the command passed the same gates as redirect pinning (no rule fired,
 *     no change of directory) and the working directory is neither the
 *     filesystem root nor the home directory;
 *   - a bounded walk of the working directory just before the command (after
 *     redirect pinning) completed within its limits and did not list the
 *     path: it did not exist then (an editor's save-by-rename of an existing
 *     file keeps its path, so it is never recorded);
 *   - the same bounded walk after the command finds it as a regular file
 *     (lstat; never a symlink, FIFO or directory), outside any dot directory
 *     and outside node_modules / vendor;
 *   - its birth time is known (non-zero, finite) and falls between the start
 *     of the command (floored to the second) and the end of it (plus 1 s of
 *     skew): a hard link or rename of an older file keeps its old birth time
 *     and is not recorded.
 * At most MAX_BORN paths are recorded per command.
 * Known window (accepted, the same class as the TOCTOU window in
 * s1-rm-single.ts): another process that creates a NEW file in the working
 * directory while the command runs has it recorded as this session's. It
 * cannot make an existing file this session's.
 */

import {
	constants,
	type Dirent,
	closeSync,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { decideRules, maskQuotes } from "../decide/rules";
import { inside } from "./s1-rm-nothing";

/** The words a recorded path may contain: no quotes, glob, `$`, `~`, spaces. */
const PLAIN_PATH = /^[A-Za-z0-9._/+,=@:-]+$/;

/**
 * What makes a file "that same file". Device and inode alone are not enough:
 * Linux hands a freed inode straight to the next file created, so a delete and
 * recreate at the same path can keep both (the Linux CI job caught this). The
 * change time and birth time in nanoseconds and the size move when a file is
 * recreated. The session's own writes refresh the entry, so they never count
 * as a replacement.
 */
type Identity = string;

/** Canonical key: the realpath of the parent directory plus the base name; null when the parent does not resolve. */
function keyOf(abs: string): string | null {
	try {
		return path.join(realpathSync(path.dirname(abs)), path.basename(abs));
	} catch {
		return null;
	}
}

/** The identity of `abs` when it is a regular file (not a symlink, not a directory), else null. */
function regularFile(abs: string): Identity | null {
	try {
		const st = lstatSync(abs, { bigint: true });
		return st.isFile() ? [st.dev, st.ino, st.ctimeNs, st.birthtimeNs, st.size].join(":") : null;
	} catch {
		return null;
	}
}

/** True when nothing exists at `abs` (lstat ENOENT; a dangling symlink exists). */
export function pathAbsent(abs: string): boolean {
	try {
		lstatSync(abs);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code === "ENOENT";
	}
}

export class CreatedFiles {
	private readonly files = new Map<string, Identity>();

	/** Record `abs` as created by this session, if it is now a regular file. */
	record(abs: string): void {
		const key = keyOf(abs);
		const id = regularFile(abs);
		if (key && id) this.files.set(key, id);
	}

	/** The session wrote `abs` again: keep its entry pointing at the file as it now is. */
	refresh(abs: string): void {
		const key = keyOf(abs);
		if (!key || !this.files.has(key)) return;
		const id = regularFile(abs);
		if (id) this.files.set(key, id);
		else this.files.delete(key);
	}

	/** Drop `abs` from the record. */
	forget(abs: string): void {
		const key = keyOf(abs);
		if (key) this.files.delete(key);
	}

	/** True when `abs` is a regular file this session created, and still that same file. */
	createdBySession(abs: string): boolean {
		const key = keyOf(abs);
		if (!key) return false;
		const want = this.files.get(key);
		const now = regularFile(abs);
		return !!want && !!now && want === now;
	}

	get size(): number {
		return this.files.size;
	}
}

/**
 * Bracket one write: call before it, and call the result after it succeeds.
 * A path that did not exist is recorded; a path already recorded is refreshed.
 */
export function watchWrite(abs: string, record: CreatedFiles | undefined): () => void {
	if (!record) return () => {};
	const wasAbsent = pathAbsent(abs);
	return () => {
		try {
			if (wasAbsent) record.record(abs);
			else record.refresh(abs);
		} catch {
			// Recording is best effort; it never affects the write.
		}
	};
}

/**
 * The plain relative paths `command` redirects output into with `>` or `>>`
 * (also `1>`, `2>`, `&>`). Targets in quotes, with `$`, `~`, a glob, an
 * absolute path or a `..` segment are left out: they are never recorded.
 */
export function redirectTargets(command: string): string[] {
	const masked = maskQuotes(command);
	const out: string[] = [];
	for (const m of masked.matchAll(/(?:\d|&)?>>?\|?[ \t]*([^\s;|&<>()]+)/g)) {
		const target = m[1] ?? "";
		const at = (m.index ?? 0) + m[0].length - target.length;
		// Masking changed it: part of it was quoted.
		if (command.slice(at, at + target.length) !== target) continue;
		if (!PLAIN_PATH.test(target) || target.startsWith("/") || target.split("/").includes(".."))
			continue;
		out.push(target);
	}
	return out;
}

/** Device and inode of `abs` when it is a regular file (lstat), else null. */
function inodeOf(abs: string): string | null {
	try {
		const st = lstatSync(abs, { bigint: true });
		return st.isFile() ? `${st.dev}:${st.ino}` : null;
	} catch {
		return null;
	}
}

const CHANGES_DIR = /(^|[\s;&|(])(cd|pushd|popd)(?=[\s;&|)]|$)/;

/** At most this many redirect targets are pinned per command; the rest are not. */
const MAX_PINNED = 64;

/**
 * Pin one redirect target. Invariant: the returned finisher records `abs`
 * only when it still names the inode created here, and refreshes a recorded
 * `abs` only when it still names the inode it had before the command.
 *   - Absent, with a parent whose realpath is inside `root`: created empty
 *     with O_EXCL; the descriptor is held until the finisher runs.
 *   - Absent with a parent that does not resolve, or resolves outside
 *     `root`: nothing is created or recorded.
 *   - Already recorded by this session: its inode is kept for comparison.
 *   - Anything else (it existed and is not this session's): nothing.
 */
function pinTarget(abs: string, root: string, record: CreatedFiles): () => void {
	if (pathAbsent(abs)) {
		let parent: string;
		try {
			parent = realpathSync(path.dirname(abs));
		} catch {
			return () => {};
		}
		if (!inside(parent, root)) return () => {};
		let fd: number;
		try {
			fd = openSync(abs, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o666);
		} catch {
			return () => {};
		}
		let pin: string | null = null;
		try {
			const st = fstatSync(fd, { bigint: true });
			pin = `${st.dev}:${st.ino}`;
		} catch {
			// No pin: never recorded.
		}
		return () => {
			try {
				if (pin !== null && inodeOf(abs) === pin) record.record(abs);
			} catch {
				// Recording is best effort; it never affects the command.
			} finally {
				closeSync(fd);
			}
		};
	}
	if (!record.createdBySession(abs)) return () => {};
	const pin = inodeOf(abs);
	return () => {
		try {
			if (pin !== null && inodeOf(abs) === pin) record.refresh(abs);
			else record.forget(abs);
		} catch {
			// Best effort.
		}
	};
}

const BORN_SKIP_DIRS = new Set(["node_modules", "vendor"]);
const BORN_MAX_DEPTH = 4;
const BORN_MAX_ENTRIES = 3000;
/** At most this many files a command's children created are recorded per command. */
const MAX_BORN = 200;
const BORN_SKEW_MS = 1000;

/**
 * Every path under `root` the bounded walk reaches (dot entries, node_modules
 * and vendor skipped; symlinks listed but never followed), and whether the
 * walk read every directory it reached without hitting the entry limit.
 * Each entry carries its Dirent.
 */
function walkTree(root: string): { paths: Map<string, Dirent>; complete: boolean } {
	const paths = new Map<string, Dirent>();
	let complete = true;
	const walk = (dir: string, depth: number) => {
		let items: Dirent[];
		try {
			items = readdirSync(dir, { withFileTypes: true });
		} catch {
			complete = false;
			return;
		}
		for (const item of items) {
			if (item.name.startsWith(".")) continue;
			if (paths.size >= BORN_MAX_ENTRIES) {
				complete = false;
				return;
			}
			const full = path.join(dir, item.name);
			paths.set(full, item);
			// The depth limit is the same before and after, so it hides the same paths both times.
			if (item.isDirectory() && !BORN_SKIP_DIRS.has(item.name) && depth < BORN_MAX_DEPTH)
				walk(full, depth + 1);
		}
	};
	walk(root, 0);
	return { paths, complete };
}

/** True when `abs` is a regular file (lstat) born at or after `sinceMs` and no later than `untilMs`. */
function bornBetween(abs: string, sinceMs: number, untilMs: number): boolean {
	try {
		const st = lstatSync(abs);
		if (!st.isFile()) return false;
		const born = Number(st.birthtimeMs);
		if (!Number.isFinite(born) || born <= 0) return false;
		return born >= sinceMs && born <= untilMs;
	} catch {
		return false;
	}
}

/**
 * Bracket one command for the files its child processes create (#4159); see
 * the module header for the invariant. `root` is the realpath of the working
 * directory. The finisher records each new regular file the walk finds.
 */
export function watchBorn(root: string, record: CreatedFiles): () => void {
	if (root === path.parse(root).root) return () => {};
	try {
		if (root === realpathSync(homedir())) return () => {};
	} catch {
		return () => {};
	}
	const since = Math.floor(Date.now() / 1000) * 1000;
	const before = walkTree(root);
	if (!before.complete) return () => {};
	return () => {
		try {
			const until = Date.now() + BORN_SKEW_MS;
			let recorded = 0;
			for (const [abs, item] of walkTree(root).paths) {
				if (recorded >= MAX_BORN) break;
				if (before.paths.has(abs) || !item.isFile()) continue;
				if (!bornBetween(abs, since, until)) continue;
				record.record(abs);
				recorded++;
			}
		} catch {
			// Recording is best effort; it never affects the command.
		}
	};
}

/**
 * Bracket one shell command: call before it runs, and call the result after
 * it exits. Invariant: a target ends up recorded only if it is still the
 * inode `pinTarget` created for it (see `pinTarget` for each case). The
 * first MAX_PINNED distinct plain targets are pinned. A command any rule
 * escalates or blocks, a command that changes directory, or a working
 * directory that does not resolve pins nothing. The same command is also
 * bracketed by `watchBorn` (#4159) for the files its children create.
 */
export function watchRedirects(
	command: string,
	cwd: string,
	record: CreatedFiles | undefined,
): () => void {
	if (!record) return () => {};
	const watches: Array<() => void> = [];
	try {
		if (CHANGES_DIR.test(maskQuotes(command))) return () => {};
		if (decideRules(command).rules.length > 0) return () => {};
		const root = realpathSync(cwd);
		const seen = new Set<string>();
		for (const t of redirectTargets(command)) {
			const abs = path.resolve(cwd, t);
			if (seen.has(abs)) continue;
			if (seen.size >= MAX_PINNED) break;
			seen.add(abs);
			watches.push(pinTarget(abs, root, record));
		}
		// After pinning, so a pinned target is "already there" to this walk and only
		// the pin decides whether it is recorded.
		watches.push(watchBorn(root, record));
	} catch {
		// Fall through with what was pinned, so every descriptor is closed.
	}
	return () => {
		for (const w of watches) w();
	};
}
