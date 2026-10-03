/**
 * System One: an `rm` that would delete nothing (#3168).
 *
 * Pilot l5-feature-e2e (main 459eb7f2) created `bunout.txt` with
 * `bun test > bunout.txt 2>&1`, then ran `rm -f .bunout.txt`, a path that
 * never existed. Rule rm_non_temp escalated, the judge blocked it, and the run
 * failed on a command that could not have removed anything.
 *
 * `rmOfNothing` answers true only when the command is a single plain `rm`
 * whose every target does not exist inside the workspace. Then there is
 * nothing to delete, so the judge is not asked. It answers false for anything
 * else, and false keeps today's behaviour (rules, then the judge).
 *
 * True needs ALL of:
 *   - decideRules fired exactly one rule, rm_non_temp, and no prompt-control text;
 *   - the whole command is words of [A-Za-z0-9._/+,=@:-] separated by spaces:
 *     no quotes, glob, `$`, backtick, `~`, redirect, pipe, `;`, `&`, `#`, newline;
 *   - the first word is `rm`, flags are only -f and -v (no -r, -R, -d, -i, `--`);
 *   - 1 to 16 paths, each relative, with no `..` segment;
 *   - each path is absent (lstat ENOENT: a dangling symlink exists, so it fails);
 *   - the nearest existing ancestor of each path resolves, after realpath,
 *     inside the realpath of the working directory.
 *
 * Own scratch files (#3177): `rmOfNothingOrOwn` also passes a path that
 * exists when ALL of these hold for it (the rest of the list above still
 * applies to the whole command):
 *   - the session's record (s1-created-files.ts) says this session created
 *     it, and it is still that same regular file (device and inode), so not a
 *     symlink or a directory;
 *   - the realpath of its parent is inside the realpath of the working
 *     directory;
 *   - git does not track it (`git ls-files` lists none of them; a working
 *     directory outside any repository tracks nothing).
 * Removing any other existing file is not allowed here: a file the session
 * did not create, one it only modified, one another tab created, a tracked
 * one.
 *
 * Absent temp paths (#3381, the narrow option James approved on 2026-10-03
 * after the 8SO review): an ABSOLUTE path passes only when ALL of these hold:
 *   - it is canonical text: no `..`, `.` or empty segment, no trailing slash;
 *   - it is absent (lstat ENOENT, so a symlink or dangling symlink fails);
 *   - its parent directory exists (no absent intermediate directories), and
 *     every component from "/" down to that parent, walked as written, is one
 *     of: a real directory (lstat, not a symlink) above the temp root, owned
 *     by root or the current uid, with (mode & 0o022) === 0; the temp root
 *     itself (realpath("/tmp"), or realpath(os.tmpdir()) when that is a macOS
 *     per-user /var/folders/../T directory), owned by root or the current
 *     uid, with (mode & 0o022) === 0 or the sticky bit; a real directory
 *     below the temp root owned by the current uid with (mode & 0o022) === 0,
 *     sticky or not; or, on macOS only, the root-owned /tmp or /var link
 *     whose exact target is private/tmp or private/var, walked in its place.
 *     Any other symlink fails closed. (8SO B1: an absent or foreign-owned
 *     ancestor in a world-writable /tmp could be swapped for a symlink out of
 *     temp between this check and the rm; 8SO B2: so could the child of a
 *     uid-owned directory that group or others can write, sticky or not;
 *     8SO B3: so could a symlink, or any entry of a group- or world-writable
 *     directory, above the temp root.)
 *     An os.tmpdir() under /tmp is reached by that walk from /tmp.
 * The text test `isTemp` in decide/rules.ts is never used here: it matches
 * `/tmp-x`, `/tmp/../etc` and any path containing `/scratchpad`. When the
 * rules fire nothing (every path looked temp to that text test), every path
 * must be absolute and pass the realpath test above; a relative path there
 * returns null.
 *
 * Own temp files (#3395, darwin only, see `birthTimeProven`): pilot l5-feature-e2e ran
 * `TODO_FILE=/tmp/tt.json bun src/cli.ts add ...`, so a child process made
 * /tmp/tt.json, then `rm -f /tmp/tt.json`, which the judge blocked. An
 * absolute path that EXISTS now also passes when ALL of these hold for it:
 *   - it is canonical text, as above, and its parent passes the same walk;
 *   - lstat says a regular file (not a symlink, not a directory) with one
 *     link, owned by the current uid;
 *   - its birth time is after the caller's CreatedFiles record opened
 *     (`startedNs`, the agent session's start, rounded up to the next ms).
 *     Modifying an older file does not move its birth time, so a file that
 *     was there before the session is never passed. No record, or a birth
 *     time of 0 (a filesystem that keeps none), fails closed.
 * The flags rule above still holds (-f and -v only, never -r), so this
 * unlinks one name in a directory no other user can write, or in the sticky
 * temp root.
 *
 * Known window: another process (the agent's background tasks, any other
 * process of this uid, or, in a shared temp root, another user) could create
 * the leaf between this check and the spawn. Only the leaf can race: every
 * component from "/" to the parent is a real directory (or one of macOS's
 * fixed root-owned /tmp and /var links) that group and others cannot write,
 * the temp root excepted only under the sticky bit, so no other user can
 * rename or replace an entry on the path, and the delete stays in that
 * directory. Under the sticky bit, rm cannot unlink another user's file in
 * the temp root itself. Not checked: macOS ACLs, which can grant add_file or
 * delete_child on a 0755 directory and which node cannot read without
 * spawning `ls -le`. Only a directory's owner or root can set one, and the
 * temp roots here carry none.
 *
 * Synchronous, never throws.
 */

import { spawnSync } from "node:child_process";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promptControlText } from "../decide/guard";
import { decideRules } from "../decide/rules";
import type { CreatedFiles } from "./s1-created-files";

const PLAIN = /^[A-Za-z0-9._/+,=@: -]+$/;
const FLAG = /^-[fv]+$/;
const MAX_PATHS = 16;

function absent(p: string): boolean {
	try {
		lstatSync(p);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code === "ENOENT";
	}
}

function inside(child: string, root: string): boolean {
	const rel = path.relative(root, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The realpath of the nearest ancestor of `abs` that exists, or null. */
function nearestExisting(abs: string): string | null {
	let cur = path.dirname(abs);
	for (;;) {
		try {
			return realpathSync(cur);
		} catch {
			const up = path.dirname(cur);
			if (up === cur) return null;
			cur = up;
		}
	}
}

/** The macOS per-user temp directory, after realpath. */
const MAC_USER_TMP = /^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/;

let rootsForTests: string[] | null = null;

/** Tests only: replace the real temp roots (realpaths), or restore them with null. */
export function _setTempRootsForTests(roots: string[] | null): void {
	rootsForTests = roots;
}

/**
 * Real temp roots, after realpath: /tmp, and os.tmpdir() only when it is the
 * macOS per-user temp directory. A TMPDIR under /tmp is not a root of its own:
 * it is reached from /tmp through the ownership walk in `parentSafe`. A TMPDIR
 * pointing anywhere else is not trusted.
 */
function tempRoots(): string[] {
	if (rootsForTests) return rootsForTests;
	const roots: string[] = [];
	try {
		const tmp = realpathSync("/tmp");
		if (tmp !== "/") roots.push(tmp);
	} catch {
		// No /tmp.
	}
	try {
		const own = realpathSync(tmpdir());
		if (MAC_USER_TMP.test(own)) roots.push(own);
	} catch {
		// No usable os.tmpdir(): /tmp alone.
	}
	return roots;
}

/**
 * The only symlinks the walk follows (8SO B3): macOS's own links at "/" that
 * lead to the temp roots, matched by exact readlink text and owner root.
 * Any other symlink, anywhere on the path, fails closed.
 */
const OS_LINKS: Readonly<Record<string, string>> =
	process.platform === "darwin" ? { tmp: "private/tmp", var: "private/var" } : {};

/**
 * True when `dir` (canonical, absolute) exists and every component from "/"
 * down to it is one of (8SO B1, B2, B3):
 *   - above the temp root: a real directory (lstat), owned by root or this
 *     uid, with (mode & 0o022) === 0;
 *   - the temp root itself: a real directory owned by root or this uid,
 *     with (mode & 0o022) === 0 or the sticky bit (/tmp is 1777);
 *   - below the temp root: a real directory owned by this uid with
 *     (mode & 0o022) === 0 (a sticky bit does not excuse it);
 *   - an OS_LINKS entry directly under "/", whose exact target is then walked
 *     in its place.
 * Anything else, a symlink above the root included, fails closed. So no other
 * user can rename or replace any entry on the path between this check and
 * the rm. `dir` may be the temp root itself.
 */
function parentSafe(dir: string): boolean {
	const uid = process.getuid?.();
	if (uid === undefined || dir === "/") return false;
	const roots = tempRoots();
	const writable = (mode: number) => (mode & 0o022) !== 0;
	const top = lstatSync("/");
	if (!top.isDirectory() || top.uid !== 0 || writable(top.mode)) return false;
	let segs = dir.slice(1).split("/");
	const link = OS_LINKS[segs[0]];
	if (link !== undefined) {
		const ln = lstatSync(`/${segs[0]}`);
		if (ln.isSymbolicLink()) {
			if (ln.uid !== 0 || readlinkSync(`/${segs[0]}`) !== link) return false;
			segs = [...link.split("/"), ...segs.slice(1)];
		}
	}
	let cur = "";
	let rooted = false;
	for (const seg of segs) {
		cur += `/${seg}`;
		const st = lstatSync(cur);
		if (st.isSymbolicLink() || !st.isDirectory()) return false;
		if (rooted) {
			if (st.uid !== uid || writable(st.mode)) return false;
			continue;
		}
		if (st.uid !== 0 && st.uid !== uid) return false;
		// No symlink has been followed except an exact OS_LINKS target, so
		// `cur` is its own realpath and compares directly with the roots.
		if (roots.includes(cur)) {
			if (writable(st.mode) && (st.mode & 0o1000) === 0) return false;
			rooted = true;
			continue;
		}
		if (writable(st.mode)) return false;
	}
	return rooted;
}

/** True when `p` is absolute with no `..`, `.` or empty segment and no trailing slash. */
function canonicalAbsolute(p: string): boolean {
	if (!p.startsWith("/") || p.endsWith("/")) return false;
	return !p
		.slice(1)
		.split("/")
		.some((s) => s === "" || s === "." || s === "..");
}

/**
 * True when `p` is a canonical absolute path that is absent and whose parent
 * directory exists and passes `parentSafe`. Any error fails closed.
 */
function absentInTemp(p: string): boolean {
	if (!canonicalAbsolute(p)) return false;
	if (!absent(p)) return false;
	try {
		return parentSafe(path.dirname(p));
	} catch {
		return false;
	}
}

let platformForTests: string | null = null;

/** Tests only: pretend to run on `platform` for the own-temp-file rule, or restore with null. */
export function _setPlatformForTests(platform: string | null): void {
	platformForTests = platform;
}

/**
 * Where birth time is proven to be a real creation time (#3395). Darwin only
 * (APFS keeps it). On Linux a runtime without statx btime can report the
 * change time as birth time, which would pass a pre-existing temp file whose
 * metadata changed this session; until that is proven otherwise, every other
 * platform keeps the #3381 absent-path rule and judges existing files.
 */
function birthTimeProven(): boolean {
	return (platformForTests ?? process.platform) === "darwin";
}

/**
 * True when `p` is a canonical absolute path to a regular file (lstat), with
 * one link, owned by this uid, born after `created.startedNs`, whose parent
 * passes `parentSafe` (#3395). Darwin only (`birthTimeProven`). Any error, or
 * no record, fails closed.
 */
function ownTempFile(p: string, created: CreatedFiles | undefined): boolean {
	if (!birthTimeProven()) return false;
	const since = created?.startedNs;
	if (typeof since !== "bigint") return false;
	if (!canonicalAbsolute(p)) return false;
	try {
		const uid = process.getuid?.();
		const st = lstatSync(p, { bigint: true });
		if (uid === undefined || !st.isFile() || st.nlink !== 1n || st.uid !== BigInt(uid))
			return false;
		if (st.birthtimeNs <= 0n || st.birthtimeNs < since) return false;
		return parentSafe(path.dirname(p));
	} catch {
		return false;
	}
}

/**
 * True when git tracks none of `rels` under `root`. A root outside any
 * repository tracks nothing. Git missing or failing otherwise: false.
 */
function noneTracked(root: string, rels: string[]): boolean {
	if (rels.length === 0) return true;
	const r = spawnSync("git", ["-C", root, "ls-files", "-z", "--", ...rels], {
		encoding: "utf8",
		timeout: 5_000,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (r.error) return false;
	if (r.status === 0) return r.stdout.length === 0;
	return r.status === 128 && /not a git repository/i.test(r.stderr ?? "");
}

/** True when `command` is a plain `rm` of paths that do not exist under `cwd`. */
export function rmOfNothing(command: string, cwd: string | undefined): boolean {
	return rmOfNothingOrOwn(command, cwd) === "nothing";
}

/**
 * "nothing" when `command` is a plain `rm` whose every path is absent in the
 * workspace; "nothing-temp" when every path is absent and at least one is an
 * absolute path under a real temp root (#3381); "own-scratch" when every path
 * is absent, an untracked file this session created, or a temp file this
 * session made (#3395), and at least one is such a file; null otherwise.
 */
export function rmOfNothingOrOwn(
	command: string,
	cwd: string | undefined,
	created?: CreatedFiles,
): "nothing" | "nothing-temp" | "own-scratch" | null {
	try {
		if (!cwd || !path.isAbsolute(cwd)) return null;
		const text = command.trim();
		if (!PLAIN.test(text)) return null;
		if (promptControlText(text) !== null) return null;
		const rules = decideRules(text);
		// No rule fired: every path looked temp to the rules' text test. Only
		// absolute paths that pass the realpath test below may then go on (#3381).
		const noRules = rules.verdict === "pass" && rules.rules.length === 0;
		const rmNonTemp =
			rules.verdict === "escalate" && rules.rules.length === 1 && rules.rules[0] === "rm_non_temp";
		if (!noRules && !rmNonTemp) return null;
		const [bin, ...args] = text.split(/ +/);
		if (bin !== "rm") return null;
		const paths = args.filter((a) => !a.startsWith("-"));
		if (args.some((a) => a.startsWith("-") && !FLAG.test(a))) return null;
		if (paths.length === 0 || paths.length > MAX_PATHS) return null;
		const root = realpathSync(cwd);
		const own: string[] = [];
		let temp = false;
		let ownTemp = false;
		for (const p of paths) {
			if (p.startsWith("/")) {
				// Absolute: an absent path under a real temp root (#3381), or a
				// temp file this session made (#3395).
				if (absentInTemp(p)) temp = true;
				else if (ownTempFile(p, created)) ownTemp = true;
				else return null;
				continue;
			}
			if (noRules || p.split("/").includes("..")) return null;
			const abs = path.resolve(root, p);
			if (!inside(abs, root)) return null;
			if (absent(abs)) {
				const anchor = nearestExisting(abs);
				if (!anchor || !inside(anchor, root)) return null;
				continue;
			}
			// It exists: only a file this session created, still the same file, may pass.
			if (!created?.createdBySession(abs)) return null;
			if (!inside(realpathSync(path.dirname(abs)), root)) return null;
			own.push(path.relative(root, path.join(realpathSync(path.dirname(abs)), path.basename(abs))));
		}
		if (own.length === 0) return ownTemp ? "own-scratch" : temp ? "nothing-temp" : "nothing";
		return noneTracked(root, own) ? "own-scratch" : null;
	} catch {
		return null;
	}
}
