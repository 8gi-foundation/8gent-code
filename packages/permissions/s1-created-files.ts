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
 * Directories (#4105): a run_command that is only `mkdir [-p] [-v] DIR...`
 * records each directory it made, that is each path (and, for a missing
 * parent, each ancestor) that was absent just before the command, is a real
 * directory just after it, and sits inside the working directory. The entry
 * keeps device, inode and birth time; a directory renamed, replaced or made
 * by anything else does not count, and a directory that already existed is
 * never recorded. Where the file system reports no birth time, nothing is
 * recorded. The directories write_file makes for a new file's
 * parent are recorded the same way (mkdirRecorded, #4516). Read by
 * s1-rm-own-dir.ts.
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
 *   - the command names the path's directory (bornScopes): for each plain
 *     relative path word in the command text (quotes masked; no `..`, `$`,
 *     `~`, glob, absolute path or dot segment other than a leading `.tmp`,
 *     the sanctioned scratch directory (#4185); for `NAME=value`, the value)
 *     the word if it is a directory, else its parent; the working directory itself is never a scope and at
 *     most MAX_BORN_SCOPES are walked. `bash video/build_slides.sh` scopes to
 *     video/; `make`, `sleep 30` and `ls` walk nothing and record nothing;
 *   - a bounded walk of that scope just before the command (after redirect
 *     pinning) completed within its limits and did not list the path: it did
 *     not exist then (an editor's save-by-rename of an existing file keeps its
 *     path, so it is never recorded). A scope whose walk was incomplete
 *     records nothing;
 *   - the same bounded walk after the command finds it as a regular file
 *     (lstat; never a symlink, FIFO or directory), outside any dot directory
 *     other than a leading `.tmp` and outside node_modules / vendor;
 *   - its birth time is known (non-zero, finite) and falls between the start
 *     of the command (floored to the second) and the end of it (plus 1 s of
 *     skew): a hard link or rename of an older file keeps its old birth time
 *     and is not recorded.
 * At most MAX_BORN paths are recorded per command.
 *
 * Birth time is not authentic and nothing here relies on it being so. On APFS
 * an unprivileged process can set it to now (`SetFile -d`,
 * setattrlist(ATTR_CMN_CRTIME)), so a script could `mv ../precious.txt
 * moved.txt` and then stamp it. What decides "did not exist before" is the
 * pre-command listing; what decides "still that file" at rm time is the
 * identity fields (device, inode, ctime ns, birth ns, size). The birth window
 * only turns away the plain hard-link and rename cases. Such a script gains no
 * new capability: it could `rm` the file itself.
 *
 * Residual window (accepted, the same class as the TOCTOU window in
 * s1-rm-single.ts): another process that creates a NEW file inside a
 * directory this command named, while the command runs, has it recorded as
 * this session's. A new file anywhere else (the project root, a directory the
 * command did not name) is never recorded, so another session's or an
 * editor's new file there still goes to the judge. It cannot make an existing
 * file this session's.
 */

import {
	constants,
	type Dirent,
	closeSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { decideRules, maskQuotes } from "../decide/rules";
import { inside } from "./s1-rm-nothing";
import { dotOutsideScratch } from "./s1-run-in-project";

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

/**
 * The identity of `abs` when it is a real directory (lstat: not a symlink):
 * device, inode and birth time. Null when it is not, or when the file system
 * reports no birth time (0), since then a recreated directory could pass for
 * the old one.
 */
export function dirIdentity(abs: string): Identity | null {
	try {
		const st = lstatSync(abs, { bigint: true });
		if (!st.isDirectory() || st.birthtimeNs <= 0n) return null;
		return [st.dev, st.ino, st.birthtimeNs].join(":");
	} catch {
		return null;
	}
}

export class CreatedFiles {
	private readonly files = new Map<string, Identity>();
	private readonly dirs = new Map<string, Identity>();

	/** Record `abs` as a directory this session created, if it is now a real directory. */
	recordDir(abs: string): void {
		const key = keyOf(abs);
		const id = dirIdentity(abs);
		if (key && id) this.dirs.set(key, id);
	}

	/** True when `abs` is a directory this session created, and still that same directory. */
	createdDirBySession(abs: string): boolean {
		const key = keyOf(abs);
		if (!key) return false;
		const want = this.dirs.get(key);
		return !!want && want === dirIdentity(abs);
	}

	get dirCount(): number {
		return this.dirs.size;
	}

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

	/**
	 * True when `abs` is a regular file this session created and it is still
	 * the file born then (device, inode, birth time), even if rewritten in
	 * place since (#4105: the pilot's CLI rewrites build/todos.json on every
	 * run). A file put at the path by a rename, a copy or anything else has
	 * another inode or birth time and does not count.
	 */
	bornToSession(abs: string): boolean {
		const key = keyOf(abs);
		if (!key) return false;
		const want = this.files.get(key)?.split(":");
		const now = regularFile(abs)?.split(":");
		if (!want || !now) return false;
		return want[0] === now[0] && want[1] === now[1] && want[3] === now[3];
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

/** At most this many directories a command names are walked for it. */
const MAX_BORN_SCOPES = 4;

/**
 * The directories `command` names, as realpaths strictly inside `root`: for
 * each plain relative path word (quotes masked first; no `..`, `$`, `~`, glob,
 * absolute path, flag, or dot (other than a leading .tmp) / node_modules / vendor segment; for a
 * `NAME=value` word, the value), the word itself when it is a directory, else
 * its parent directory. The root itself is
 * never a scope, so a command naming no path (`make`, `sleep 30`, `ls`) gets
 * none. A scope inside another scope is dropped; at most MAX_BORN_SCOPES are
 * kept, in the order the command names them.
 */
export function bornScopes(command: string, root: string): string[] {
	const masked = maskQuotes(command);
	const found: string[] = [];
	for (const m of masked.matchAll(/[^\s;|&<>()]+/g)) {
		const at = m.index ?? 0;
		// Masking changed it: part of it was quoted.
		if (command.slice(at, at + m[0].length) !== m[0]) continue;
		// `NAME=path` (an env assignment such as the pilot's
		// TODO_FILE=build/todos.json, #4105) names `path`.
		const word = /^[A-Za-z_][A-Za-z0-9_]*=(.+)$/.exec(m[0])?.[1] ?? m[0];
		if (!PLAIN_PATH.test(word) || word.startsWith("/") || word.startsWith("-")) continue;
		const segs = word.split("/").filter((s) => s !== "" && s !== ".");
		if (segs.length === 0 || segs.includes("..")) continue;
		if (dotOutsideScratch(segs) || segs.some((s) => BORN_SKIP_DIRS.has(s))) continue;
		const abs = path.resolve(root, ...segs);
		let isDir = false;
		try {
			isDir = lstatSync(abs).isDirectory();
		} catch {
			// Absent (a file the command will write): its parent is the scope.
		}
		let dir: string;
		try {
			dir = realpathSync(isDir ? abs : path.dirname(abs));
		} catch {
			continue;
		}
		if (dir === root || !inside(dir, root)) continue;
		const rel = path.relative(root, dir).split(path.sep);
		if (dotOutsideScratch(rel) || rel.some((s) => BORN_SKIP_DIRS.has(s))) continue;
		if (!found.includes(dir)) found.push(dir);
	}
	const within = (a: string, b: string) => a !== b && a.startsWith(`${b}${path.sep}`);
	return found.filter((d) => !found.some((o) => within(d, o))).slice(0, MAX_BORN_SCOPES);
}

/** True when `dir` is still a real directory (lstat, not a symlink) whose realpath is itself. */
function stillDir(dir: string): boolean {
	try {
		return lstatSync(dir).isDirectory() && realpathSync(dir) === dir;
	} catch {
		return false;
	}
}

/**
 * Bracket one command for the files its child processes create (#4159); see
 * the module header for the invariant. `root` is the realpath of the working
 * directory. Only the directories the command names are walked (bornScopes),
 * each with its own limits; a scope whose walk before the command was
 * incomplete records nothing. The finisher records each new regular file the
 * walks find.
 */
export function watchBorn(command: string, root: string, record: CreatedFiles): () => void {
	if (root === path.parse(root).root) return () => {};
	try {
		if (root === realpathSync(homedir())) return () => {};
	} catch {
		return () => {};
	}
	const since = Math.floor(Date.now() / 1000) * 1000;
	const scopes: Array<{ dir: string; before: Map<string, Dirent> }> = [];
	for (const dir of bornScopes(command, root)) {
		const before = walkTree(dir);
		if (before.complete) scopes.push({ dir, before: before.paths });
	}
	if (scopes.length === 0) return () => {};
	return () => {
		try {
			const until = Date.now() + BORN_SKEW_MS;
			let recorded = 0;
			for (const { dir, before } of scopes) {
				// The command may have swapped the scope for a symlink (`mv video video.old;
				// ln -s $OUTSIDE video`): a scope that is no longer that same real directory is skipped.
				if (!stillDir(dir)) continue;
				for (const [abs, item] of walkTree(dir).paths) {
					if (recorded >= MAX_BORN) return;
					if (before.has(abs) || !item.isFile()) continue;
					if (!bornBetween(abs, since, until)) continue;
					// And each file's real parent must still be inside the scope.
					if (!inside(realpathSync(path.dirname(abs)), dir)) continue;
					record.record(abs);
					recorded++;
				}
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
	// A mkdir-only command records the directories it makes (#4105).
	const watches: Array<() => void> = [watchMkdir(command, cwd, record)];
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
		watches.push(watchBorn(command, root, record));
	} catch {
		// Fall through with what was pinned, so every descriptor is closed.
	}
	return () => {
		for (const w of watches) w();
	};
}

/** `mkdir` with only -p / -v flags and 1 to 16 plain relative paths, nothing else on the line. */
const MKDIR_FLAG = /^-[pv]+$/;
const MAX_MKDIR = 16;

/**
 * Bracket a mkdir-only command (#4105): call before it runs, and call the
 * result after it exits. Records each directory the command made: a path,
 * or an ancestor of it, that was absent before, is a real directory after,
 * whose realpath is inside the realpath of `cwd`, and that was born no
 * earlier than one second before the command started (8SO on #4106: an older
 * directory renamed onto the path during the command keeps its old birth
 * time, so it is not recorded; the second of slack covers coarse clocks).
 * Any other command records nothing. Never throws.
 */
export function watchMkdir(command: string, cwd: string, record: CreatedFiles): () => void {
	try {
		const text = command.trim();
		if (!PLAIN_PATH.test(text.replace(/ /g, "_"))) return () => {};
		const [bin, ...args] = text.split(/ +/);
		if (bin !== "mkdir") return () => {};
		const paths: string[] = [];
		for (const a of args) {
			if (a.startsWith("-")) {
				if (paths.length > 0 || !MKDIR_FLAG.test(a)) return () => {};
				continue;
			}
			const segs = a.replace(/\/$/, "").split("/");
			if (a.startsWith("/") || segs.some((s) => s === "" || s === "." || s === ".."))
				return () => {};
			paths.push(a);
		}
		if (paths.length === 0 || paths.length > MAX_MKDIR) return () => {};
		if (decideRules(text).rules.length > 0) return () => {};
		const root = realpathSync(cwd);
		const since = BigInt(Date.now() - 1000) * 1_000_000n;
		const fresh: string[] = [];
		for (const p of paths) {
			let cur = path.resolve(cwd, p.replace(/\/$/, ""));
			while (cur !== path.dirname(cur) && pathAbsent(cur)) {
				fresh.push(cur);
				cur = path.dirname(cur);
			}
		}
		return () => {
			for (const abs of fresh) {
				try {
					const key = keyOf(abs);
					if (!key || !inside(key, root) || key === root) continue;
					const st = lstatSync(abs, { bigint: true });
					if (st.isDirectory() && st.birthtimeNs >= since) record.recordDir(abs);
				} catch {
					// Recording is best effort; it never affects the command.
				}
			}
		};
	} catch {
		return () => {};
	}
}

/**
 * `mkdir -p dir` for write_file (#4516): makes the missing directories and
 * records each one it made, deepest first up to the first that already existed,
 * so rm -r of the session's own scratch directory (s1-rm-own-dir.ts) can tell
 * it from a directory that was there before. Same guard as watchMkdir: a new
 * directory is recorded only when its realpath is strictly inside the realpath
 * of `cwd` and it was born no earlier than one second before this call. An
 * absolute or `..` path that lands outside the cwd records nothing. Never
 * throws from the recording; the mkdir error itself propagates as before.
 */
export function mkdirRecorded(dir: string, cwd: string, record: CreatedFiles | undefined): void {
	const fresh: string[] = [];
	let cur = path.resolve(dir);
	while (cur !== path.dirname(cur) && pathAbsent(cur)) {
		fresh.push(cur);
		cur = path.dirname(cur);
	}
	const since = BigInt(Date.now() - 1000) * 1_000_000n;
	mkdirSync(dir, { recursive: true });
	if (!record) return;
	try {
		const root = realpathSync(cwd);
		for (const abs of fresh) {
			const key = keyOf(abs);
			if (!key || !inside(key, root) || key === root) continue;
			const st = lstatSync(abs, { bigint: true });
			if (st.isDirectory() && st.birthtimeNs >= since) record.recordDir(abs);
		}
	} catch {
		// Recording is best effort; it never affects the write.
	}
}
