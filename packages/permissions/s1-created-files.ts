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
 *   - (#3514) a run_command after which a NEW untracked, non-ignored name
 *     holds a regular file written during the command: `git ls-files -o
 *     --exclude-standard` is taken before and after, and a name absent before,
 *     present after, never seen before any earlier command of this record,
 *     with one hard link and a modification time at or after the command
 *     start, is recorded (pilot: a CLI run as TODO_FILE=.tmp/td.json bun
 *     src/cli.ts add ... makes .tmp/td.json; a child made it, not a redirect).
 *     Not recorded: a name that existed before (sed -i, an atomic save, touch),
 *     a name seen before any earlier command (git stash -u then pop recreates
 *     it), a gitignored name (.env), a file moved in (mv keeps its mtime),
 *     a hard link, anything from a command during which an untracked name
 *     that was not this session's vanished; anything when the snapshot fails (no repository, git missing, a 5 s timeout, more
 *     than 5,000 untracked names, more than 20,000 names seen): fail closed,
 *     and the watch stays off for the rest of the session, as it does after
 *     one snapshot slower than 500 ms.
 *     An own entry is refreshed after a command only when it still names the
 *     same device and inode, or a fresh file written during the command.
 *     Known gap, for 8SO: another process (an editor, another tab) creating a
 *     brand-new untracked file in the workspace while a command runs is
 *     recorded, and so is a file moved in whose mtime a child of the command
 *     reset. The second needs a child process, which can delete files without
 *     System One seeing it anyway.
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
 */

import { spawnSync } from "node:child_process";
import { constants, closeSync, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
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

/** Untracked names one snapshot may hold (#3514); more records nothing. */
const MAX_UNTRACKED = 5_000;
/** A snapshot slower than this (ms), or any failed one, stops the watch for the session (#3514). */
const SLOW_SNAPSHOT_MS = 500;
/** Names one record may remember as seen (#3514); past this it records nothing new. */
const MAX_SEEN = 20_000;

/**
 * The names `git ls-files <args> -z` lists under `cwd`, as absolute paths
 * under its realpath. Null when `cwd` is not in a repository, git fails or
 * times out (5 s), or there are more than MAX_UNTRACKED of them.
 */
function gitNames(cwd: string, args: string[]): string[] | null {
	try {
		const root = realpathSync(cwd);
		const r = spawnSync("git", ["-C", root, "ls-files", ...args, "-z"], {
			encoding: "utf8",
			timeout: 5_000,
			maxBuffer: 16 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (r.error || r.status !== 0) return null;
		const names = r.stdout.split("\0").filter(Boolean);
		if (names.length > MAX_UNTRACKED) return null;
		return names.map((n) => path.resolve(root, n));
	} catch {
		return null;
	}
}

/** True when `abs` is a regular file (lstat) with one link, written at or after `startNs`. */
function writtenSince(abs: string, startNs: bigint): boolean {
	try {
		const st = lstatSync(abs, { bigint: true });
		return st.isFile() && st.nlink === 1n && st.mtimeNs >= startNs;
	} catch {
		return false;
	}
}

export class CreatedFiles {
	private readonly files = new Map<string, Identity>();
	/** Every untracked name present when one of this record's commands started (#3514). */
	private readonly seen = new Set<string>();
	private seenFull = false;
	/** Set once a snapshot failed or was slow (#3514): the watch stays off for this record. */
	private tripped = false;

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

	/** Circuit breaker: stop watching commands for the rest of this record, so deletes go to the judge. */
	private trip(): () => void {
		this.tripped = true;
		return () => {};
	}

	/** True once a snapshot failed or took over SLOW_SNAPSHOT_MS (tests and diagnostics). */
	get watchStopped(): boolean {
		return this.tripped;
	}

	/**
	 * Bracket one of the session's own commands by untracked-name snapshots
	 * (#3514): call before it runs, and call the result after it exits. A name
	 * absent before, present after, and never seen before any earlier command
	 * is recorded when it is a regular file written during the command. Own
	 * entries that survive the command are refreshed. Any snapshot failure, or
	 * a vanished name, records and refreshes nothing.
	 */
	watchCommand(cwd: string): () => void {
		if (this.tripped) return () => {};
		const start = (BigInt(Date.now()) + 1n) * 1_000_000n;
		const t0 = Date.now();
		const before = gitNames(cwd, ["-o", "--exclude-standard"]);
		if (Date.now() - t0 > SLOW_SNAPSHOT_MS) return this.trip();
		if (!before) return this.trip();
		const ours = new Map<string, string>();
		for (const abs of before) {
			const id = this.createdBySession(abs) ? inodeOf(abs) : null;
			if (id) ours.set(abs, id);
		}
		for (const abs of before) this.seen.add(abs);
		if (this.seen.size > MAX_SEEN) this.seenFull = true;
		let open = true;
		return () => {
			if (!open) return;
			open = false;
			const t1 = Date.now();
			const after = gitNames(cwd, ["-o", "--exclude-standard"]);
			if (Date.now() - t1 > SLOW_SNAPSHOT_MS) this.trip();
			if (!after) {
				this.trip();
				return;
			}
			if (this.tripped) return;
			// A name that was not ours vanished: something was moved or deleted,
			// so a new name may be that file.
			const now = new Set(after);
			if (before.some((abs) => !ours.has(abs) && !now.has(abs))) return;
			for (const [abs, id] of ours) {
				// In place (same inode), or a fresh file the command wrote over it.
				if (inodeOf(abs) === id || writtenSince(abs, start)) this.refresh(abs);
			}
			if (this.seenFull) return;
			for (const abs of after)
				if (!this.seen.has(abs) && writtenSince(abs, start)) this.record(abs);
		};
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

/**
 * Bracket one shell command: call before it runs, and call the result after
 * it exits. Invariant: a target ends up recorded only if it is still the
 * inode `pinTarget` created for it (see `pinTarget` for each case). The
 * first MAX_PINNED distinct plain targets are pinned. A command any rule
 * escalates or blocks, a command that changes directory, or a working
 * directory that does not resolve pins nothing.
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
		// After the pins, so a redirect target they pre-created is already "seen" here.
		watches.push(record.watchCommand(cwd));
	} catch {
		// Fall through with what was pinned, so every descriptor is closed.
	}
	return () => {
		for (const w of watches) w();
	};
}
