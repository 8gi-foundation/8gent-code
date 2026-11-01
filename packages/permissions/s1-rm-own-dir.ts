/**
 * System One: `rm -r` of a scratch directory this session made itself (#4105).
 *
 * Pilot l5-feature-e2e (main ee975ade, run 2026-10-12_194129) ran `mkdir -p
 * build` for a manual smoke test (TODO_FILE=build/todos.json), finished the
 * feature, then cleaned up with `rm -rf build`. Rule rm_recursive escalated,
 * the judge blocked it (pYes 0.9156), and the run failed 18/19 on its own
 * scratch folder; the same check failed on 11 Oct. Same design as
 * s1-login-line.ts: an ALLOWLIST of one exact shape, never a deny-list.
 * Anything else is "no opinion" and goes to the judge as before. The gate
 * calls this only in System One's default mode.
 *
 * `rmOwnDir` answers ok only when ALL hold:
 *   - POSIX (never on win32), an absolute working directory, a session record;
 *   - the whole command is `rm FLAGS PATH...`: words of [A-Za-z0-9._/+,=@:-]
 *     separated by spaces, so no quotes, glob, `$`, backtick, `~`, redirect,
 *     pipe, `;`, `&`, `#`, newline; FLAGS are one or more of -r -R -f -v
 *     (at least one r or R), all before the first path; no `--`, no long
 *     option; 1 to 8 paths;
 *   - decideRules fires exactly rm_recursive, and no prompt-control text;
 *   - or (#4185, widened by #4711) the command is `rmdir PATH...` with no flag
 *     at all, and decideRules fires exactly rmdir_non_temp; every condition
 *     below applies to it the same way, so it passes only for a directory this
 *     session made (a model that made `tmp/` could not remove it, #4711);
 *   - each PATH is relative, has no `.`, `..` or empty segment (one trailing
 *     slash is fine; a leading `./` only before `.tmp`), no segment starting
 *     with `.` (dotfile, dot directory, .git) except a first segment that is
 *     exactly `.tmp`, the one sanctioned scratch directory directly under
 *     the working directory (#4185), is not the workspace root, not a secret
 *     or protected path;
 *   - no component from the workspace root down to it is a symlink, and it is
 *     a real directory;
 *   - the session's record (s1-created-files.ts) says a mkdir-only
 *     run_command of this session made it, and it is still that directory
 *     (device, inode, birth time): a renamed, replaced or pre-existing
 *     directory does not pass;
 *   - git tracks nothing under it (outside a repository nothing is tracked);
 *   - every entry under it (at most 2000) is on the same device (no mount
 *     point), is not named .git, and was born no earlier than the directory
 *     itself, so nothing older was moved into it;
 *   - every entry under it is the session's own (8TO on #4106, after #4160):
 *     a directory a mkdir-only run_command of this session made, or a
 *     regular file the record says this session wrote (write_file, a
 *     redirect, or a file a command's child created in a directory the
 *     command named) and that is still that file, rewritten in place or not.
 *     A file another process dropped in, a directory something else made, a
 *     symlink, FIFO or socket all send the rm to the judge.
 *
 * When the command is a plain recursive rm but a path fails, the result
 * carries a hint for the block message saying what would pass.
 *
 * Known limits, on purpose: TOCTOU between this check and the spawn (accepted
 * by 8SO for the sibling lanes). A directory write_file made for a new file's
 * parent is in the record since #4516 (mkdirRecorded), like a mkdir's.
 *
 * Synchronous, never throws.
 */

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { promptControlText } from "../decide/guard";
import { decideRules } from "../decide/rules";
import type { CreatedFiles } from "./s1-created-files";
import { protectedRel } from "./s1-mv-in-project";
import { inside } from "./s1-rm-nothing";
import { SCRATCH_DIR, SECRET, dotOutsideScratch } from "./s1-run-in-project";

export type RmOwnDir = { ok: true; reason: string } | { ok: false; hint?: string };

const PLAIN = /^[A-Za-z0-9._/+,=@: -]+$/;
const FLAG = /^-[rRfv]+$/;
const MAX_PATHS = 8;
const MAX_ENTRIES = 2000;
const NO: RmOwnDir = { ok: false };

const WHAT_PASSES =
	"A recursive delete runs without review only as `rm -rf DIR` (or `rmdir DIR`) where DIR is a plain relative directory inside the workspace (no dot names other than a leading .tmp, no symlink on its path) that this session made with a run_command that was only `mkdir`, that git does not track, and that holds only files this session wrote and directories it made the same way.";

function hint(why: string): RmOwnDir {
	return {
		ok: false,
		hint: `${why} ${WHAT_PASSES} Otherwise remove the files you created one by one with \`rm -f\`, or ask the user.`,
	};
}

/** True when git tracks nothing under `rel`. Outside a repository: true. Git failing otherwise: false. */
function untracked(root: string, rel: string): boolean {
	const r = spawnSync("git", ["-C", root, "ls-files", "-z", "--", rel], {
		encoding: "utf8",
		timeout: 5_000,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (r.error) return false;
	if (r.status === 0) return r.stdout.length === 0;
	return r.status === 128 && /not a git repository/i.test(r.stderr ?? "");
}

/**
 * The harness's own marker (#4316): packages/eight/scratch-exclude.ts writes `.tmp/.gitignore`
 * holding exactly `*\n` so scratch stays out of git status without editing .git. It is not a
 * file the session wrote, but it is ours and inert. Only that exact file, directly under the
 * workspace's `.tmp`, as a regular file with exactly that content.
 */
function isScratchMarker(
	abs: string,
	root: string,
	st: { isFile(): boolean; size: bigint; nlink: bigint },
): boolean {
	try {
		if (
			abs !== path.join(root, SCRATCH_DIR, ".gitignore") ||
			!st.isFile() ||
			st.size !== 2n ||
			st.nlink !== 1n
		)
			return false;
		return readFileSync(abs, "utf8") === "*\n";
	} catch {
		return false;
	}
}

/** Null when every entry under `dir` is fine (see the header), else why not. */
function contentsProblem(dir: string, created: CreatedFiles, root: string): string | null {
	const top = lstatSync(dir, { bigint: true });
	const stack = [dir];
	let seen = 0;
	while (stack.length > 0) {
		const cur = stack.pop() as string;
		for (const name of readdirSync(cur)) {
			if (++seen > MAX_ENTRIES) return `it holds more than ${MAX_ENTRIES} entries.`;
			if (name === ".git") return "it holds a .git entry.";
			const abs = path.join(cur, name);
			const st = lstatSync(abs, { bigint: true });
			if (st.dev !== top.dev) return "it holds a mount point.";
			if (isScratchMarker(abs, root, st)) continue;
			if (st.birthtimeNs <= 0n || st.birthtimeNs < top.birthtimeNs)
				return `it holds ${path.relative(dir, abs)}, which is older than the directory (moved in from elsewhere).`;
			if (st.isDirectory()) {
				if (!created.createdDirBySession(abs))
					return `it holds the directory ${path.relative(dir, abs)}, which this session did not make with a mkdir-only run_command.`;
				stack.push(abs);
			} else if (!st.isFile() || !created.bornToSession(abs)) {
				return `it holds ${path.relative(dir, abs)}, which is not a file this session wrote.`;
			}
		}
	}
	return null;
}

/**
 * ok when `command` is a plain recursive rm of directories this session made
 * with a mkdir-only run_command; see the header.
 */
export function rmOwnDir(
	command: string,
	cwd: string | undefined,
	created: CreatedFiles | undefined,
): RmOwnDir {
	try {
		if (process.platform === "win32" || !cwd || !path.isAbsolute(cwd) || !created) return NO;
		const text = command.trim();
		const rmdir = text.startsWith("rmdir ");
		if (!(rmdir || text.startsWith("rm ")) || !PLAIN.test(text)) return NO;
		if (promptControlText(text) !== null) return NO;
		const rules = decideRules(text).rules;
		if (rules.length !== 1 || rules[0] !== (rmdir ? "rmdir_non_temp" : "rm_recursive")) return NO;
		const [, ...args] = text.split(/ +/);
		const paths: string[] = [];
		let recursive = rmdir;
		for (const a of args) {
			if (a.startsWith("-")) {
				if (rmdir || paths.length > 0 || !FLAG.test(a))
					return hint(`\`${a}\` is not allowed here.`);
				if (/[rR]/.test(a)) recursive = true;
				continue;
			}
			paths.push(a);
		}
		if (!recursive || paths.length === 0 || paths.length > MAX_PATHS) return NO;
		const root = realpathSync(cwd);
		const names: string[] = [];
		for (const p of paths) {
			// `./.tmp` is `.tmp`; any other leading `./` stays a refusal, as before.
			const bare = p === `./${SCRATCH_DIR}` || p.startsWith(`./${SCRATCH_DIR}/`) ? p.slice(2) : p;
			const rel = bare.endsWith("/") ? bare.slice(0, -1) : bare;
			const segs = rel.split("/");
			if (p.startsWith("/") || segs.some((s) => s === "" || s === "." || s === ".."))
				return hint(`\`${p}\` is not a plain relative path.`);
			if (dotOutsideScratch(segs)) return hint(`\`${p}\` is or is inside a dot entry.`);
			if (SECRET.test(rel) || protectedRel(rel)) return hint(`\`${p}\` is a protected path.`);
			let cur = root;
			for (const s of segs) {
				cur = path.join(cur, s);
				const st = lstatSync(cur, { throwIfNoEntry: false });
				if (!st) return hint(`\`${p}\` does not exist.`);
				if (st.isSymbolicLink()) return hint(`\`${p}\` has a symlink on its path.`);
			}
			if (!lstatSync(cur).isDirectory()) return hint(`\`${p}\` is not a directory.`);
			if (cur === root || !inside(cur, root)) return hint(`\`${p}\` is not below the workspace.`);
			if (!created.createdDirBySession(cur))
				return hint(`\`${p}\` is not a directory this session made with a mkdir-only run_command.`);
			if (!untracked(root, rel)) return hint(`git tracks files under \`${p}\`.`);
			const why = contentsProblem(cur, created, root);
			if (why) return hint(`\`${p}\`: ${why}`);
			names.push(rel);
		}
		return {
			ok: true,
			reason: `${rmdir ? "rmdir" : "rm -r"} of directories this session made (${names.join(", ")}): untracked, only the session's own files inside`,
		};
	} catch {
		return NO;
	}
}
