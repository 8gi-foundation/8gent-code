/**
 * System One: removing one stale scratch file in the workspace (#3669).
 *
 * Pilot troubleshoot-practice (main a5f476d8, run 2026-10-08_185418): the
 * agent found the lock owner pid dead and ran `rm -f run/worker.lock`, then
 * `unlink run/worker.lock`. Rules rm_non_temp and unlink escalated, the judge
 * blocked both (pYes 0.77, 0.70), and the turn ran to its time limit. The
 * file existed before the session, so the own-scratch rule (#3177) could not
 * cover it, and nothing else in the rules-first lane looks at an existing
 * file.
 *
 * `singleFileDelete` answers ok only when the command removes exactly one
 * explicitly named, untracked, scratch-style regular file inside the
 * workspace. Then the judge is not asked. Anything else keeps today's
 * behaviour (rules, then the judge), with a plain-words hint for the block
 * message when the command was nearly that shape.
 *
 * ok needs ALL of:
 *   - a working directory, absolute;
 *   - the whole command is words of [A-Za-z0-9._/+,=@:-] separated by spaces:
 *     no quotes, glob, brace, `$`, backtick, `~`, redirect, pipe, `;`, `&`,
 *     `#`, newline; and no prompt-control text;
 *   - decideRules fired exactly one rule: rm_non_temp (for `rm`) or unlink;
 *   - the first word is `rm` with flags only -f / -v (no -r, -R, -d, -i,
 *     `--`), or `unlink` with no flags;
 *   - exactly one path operand, relative, with no `..` segment and no `.git`
 *     segment (case-insensitive) as written;
 *   - lstat says it is a regular file: not a directory, not a symlink (a
 *     symlink pointing anywhere, inside or out, goes to the judge);
 *   - the realpath of its parent directory is inside the realpath of the
 *     working directory (a symlinked directory that escapes fails), and the
 *     real relative path has no `.git` segment either;
 *   - it is scratch-style: a directory segment of the real relative path is
 *     one of run, tmp, .cache, or the base name ends in .lock or .pid; or
 *     (#3943) it is a generated-data file born in the last two hours (birth time,
 *     not mtime; unavailable or future birth time fails closed): a .json under
 *     .tmp/ that is not tooling config, or a name that passes the positive
 *     generatedDataName allowlist in s1-mv-in-project.ts (e2e, todo, tmp, out
 *     or result in the stem; never *rc or *config); no dot directory above it
 *     other than a leading .tmp. `rm -f e2e.json` passes; an untracked
 *     old.log, a .txt, or a json older than that, still goes to the judge;
 *   - its base name is not a dependency lockfile (bun.lock, yarn.lock,
 *     Cargo.lock, ... see LOCKFILES) and not a sensitive name (.env*, *.pem,
 *     *.key, *.p12, *.sqlite*, *.db), scratch directory or not;
 *   - git does not track it. The check runs from the file's own real
 *     directory, so a nested repository or submodule there is the one asked,
 *     and matches the base name literally and case-insensitively, so a
 *     different spelling of the same name on a case-insensitive file system
 *     is the same file. Staged counts as tracked. A directory outside any
 *     repository tracks nothing. The spawn env drops GIT_DIR, GIT_WORK_TREE,
 *     GIT_INDEX_FILE, GIT_COMMON_DIR and GIT_CEILING_DIRECTORIES, so the
 *     repository asked is always the one on disk at that directory. Git
 *     missing or failing otherwise counts as tracked.
 *
 * Not covered here on purpose: `mv` (see s1-mv-in-project.ts); more than one operand; any
 * untracked file that is not scratch-style (an untracked `.env` is
 * unrecoverable, and s1-rm-nothing.test.ts already requires `rm -f old.log`
 * at the root to be judged); any tracked file, under run/ or not.
 *
 * Known window (TOCTOU, accepted by 8SO), the same as #3177: a process of this uid could swap the
 * parent directory for a symlink between this check and the spawn. The leaf
 * cannot be used for that: rm of a symlink removes the link, not its target.
 *
 * Synchronous, never throws.
 */

import { spawnSync } from "node:child_process";
import { type Stats, lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { promptControlText } from "../decide/guard";
import { decideRules } from "../decide/rules";
import { SENSITIVE_NAME, generatedDataName, plainJsonName } from "./s1-mv-in-project";
import { inside } from "./s1-rm-nothing";

const PLAIN = /^[A-Za-z0-9._/+,=@: -]+$/;
const RM_FLAG = /^-[fv]+$/;
const SCRATCH_DIRS = new Set(["run", "tmp", ".cache"]);
const SCRATCH_NAME = /\.(lock|pid)$/;
/** A generated-data file (#3943) counts as scratch only while it is this fresh. */
const RECENT_MS = 2 * 60 * 60 * 1000;
const SKEW_MS = 1000;
/** Dependency lockfiles end in .lock too, but they are project state, not scratch (compared lower-cased). */
const LOCKFILES = new Set([
	"bun.lock",
	"bun.lockb",
	"yarn.lock",
	"cargo.lock",
	"gemfile.lock",
	"poetry.lock",
	"uv.lock",
	"pdm.lock",
	"composer.lock",
	"mix.lock",
	"pubspec.lock",
	"podfile.lock",
	"flake.lock",
	"deno.lock",
]);
/** Inherited git env that would point the tracked check at a different repository. */
const GIT_REDIRECT_ENV = new Set([
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_CEILING_DIRECTORIES",
]);

export type SingleFileDelete =
	| { ok: true; rel: string }
	| {
			ok: false;
			/** Plain words for the block message when the command was nearly the allowed shape; absent otherwise. */
			hint?: string;
	  };

/** The one sentence every hint ends with: what the rule does allow. */
export const SINGLE_FILE_DELETE_HINT =
	"Without review you can remove one explicitly named untracked file under run/, tmp/ or .cache/, or one *.lock / *.pid file, inside the working directory.";

function no(hint?: string): SingleFileDelete {
	return hint ? { ok: false, hint: `${hint} ${SINGLE_FILE_DELETE_HINT}` } : { ok: false };
}

function hasGitSegment(rel: string): boolean {
	return rel.split("/").some((s) => s.toLowerCase() === ".git");
}

/**
 * Created within RECENT_MS, by BIRTH time. mtime is useless here: `touch` makes
 * any file look fresh and a future mtime gives a negative age. Fails closed
 * (to the judge) when birth time is unavailable: some file systems and Node
 * builds report 0, or fall back to ctime, notably Linux ext4 without statx
 * birth support; a ctime fallback is also reset by chmod/rename, so a zero,
 * non-finite or future value is never trusted.
 */
function freshlyBorn(st: Stats): boolean {
	const born = Number(st.birthtimeMs);
	if (!Number.isFinite(born) || born <= 0) return false;
	const age = Date.now() - born;
	// A file written this instant can read a hair ahead of Date.now() (timestamp granularity);
	// anything more than a second ahead is a forged clock and fails closed.
	return age >= -SKEW_MS && age < RECENT_MS;
}

/** A dot directory anywhere above the file, other than a leading .tmp. */
function hasDotDir(rel: string): boolean {
	const dirs = rel.split("/").slice(0, -1);
	return dirs.some((s, i) => s.startsWith(".") && !(s === ".tmp" && i === 0));
}

function scratchStyle(rel: string): boolean {
	const segs = rel.split("/");
	const base = segs.pop() ?? "";
	return segs.some((s) => SCRATCH_DIRS.has(s)) || SCRATCH_NAME.test(base);
}

/**
 * True when the repository that owns `dir` (the file's real parent) tracks a
 * file named `base` there, index entries included. Asked from `dir` itself,
 * so a nested repository or submodule is the one that answers; the name is
 * matched as literal text, case-insensitively (`:(literal,icase)`), so no
 * glob or magic in it is interpreted and a different spelling of the same
 * name on a case-insensitive file system still counts. GIT_REDIRECT_ENV is
 * dropped from the spawn env. A directory outside any repository tracks
 * nothing. Git missing or failing otherwise counts as tracked, so the judge
 * is asked.
 */
function tracked(dir: string, base: string): boolean {
	const env = { ...process.env };
	for (const k of GIT_REDIRECT_ENV) delete env[k];
	const r = spawnSync("git", ["-C", dir, "ls-files", "-z", "--", `:(literal,icase)${base}`], {
		encoding: "utf8",
		timeout: 5_000,
		stdio: ["ignore", "pipe", "pipe"],
		env,
	});
	if (r.error) return true;
	if (r.status === 0) return r.stdout.length > 0;
	return !(r.status === 128 && /not a git repository/i.test(r.stderr ?? ""));
}

/**
 * ok when `command` is `rm [-f] <file>` or `unlink <file>` of exactly one
 * untracked scratch-style regular file inside `cwd`; see the header for every
 * condition. Otherwise not ok, with a hint when it was close.
 */
export function singleFileDelete(command: string, cwd: string | undefined): SingleFileDelete {
	try {
		if (!cwd || !path.isAbsolute(cwd)) return no();
		const text = command.trim();
		const words = text.split(/ +/);
		const bin = words[0];
		if (bin !== "rm" && bin !== "unlink") return no();
		if (!PLAIN.test(text))
			return no("Name one file explicitly, with no wildcards, quotes or variables.");
		if (promptControlText(text) !== null) return no();
		const rules = decideRules(text);
		const want = bin === "rm" ? "rm_non_temp" : "unlink";
		if (rules.verdict !== "escalate" || rules.rules.length !== 1 || rules.rules[0] !== want) {
			return rules.rules.includes("rm_recursive")
				? no("A recursive delete always needs review.")
				: no();
		}
		const args = words.slice(1);
		const flags = args.filter((a) => a.startsWith("-"));
		const paths = args.filter((a) => !a.startsWith("-"));
		if (bin === "unlink" ? flags.length > 0 : flags.some((f) => !RM_FLAG.test(f))) return no();
		if (paths.length !== 1) return no("Remove one file per command.");
		const p = paths[0];
		// .git internals are never close to allowed: no hint.
		if (hasGitSegment(p)) return no();
		if (p.startsWith("/") || p.split("/").includes(".."))
			return no(
				"Only a file inside the working directory, named by a relative path, can be removed without review.",
			);
		const root = realpathSync(cwd);
		const abs = path.resolve(root, p);
		if (!inside(abs, root)) return no();
		let st: Stats;
		try {
			st = lstatSync(abs);
		} catch {
			return no();
		}
		if (st.isDirectory()) return no("That is a directory; removing a directory needs review.");
		if (!st.isFile())
			return no("Only a regular file (not a symlink) can be removed without review.");
		const realParent = realpathSync(path.dirname(abs));
		if (!inside(realParent, root)) return no("That path resolves outside the working directory.");
		const base = path.basename(abs);
		// Segments are split on "/" below and reported to the model: keep them POSIX-style on Windows.
		const rel = path.relative(root, path.join(realParent, base)).split(path.sep).join("/");
		if (hasGitSegment(rel)) return no();
		// A data file the task just wrote (`e2e.json`) is scratch while it is fresh, untracked and
		// either under .tmp/ (and not tooling config) or named like generated data.
		const fresh =
			freshlyBorn(st) &&
			!hasDotDir(rel) &&
			((rel.startsWith(".tmp/") && plainJsonName(base)) || generatedDataName(base));
		if (!scratchStyle(rel) && !fresh) return no("That file is not a scratch file.");
		if (LOCKFILES.has(base.toLowerCase()))
			return no("That is a dependency lockfile, not a scratch file.");
		if (SENSITIVE_NAME.test(base)) return no("That file name needs review.");
		if (tracked(realParent, base)) return no("That file is tracked by git.");
		return { ok: true, rel };
	} catch {
		return no();
	}
}
