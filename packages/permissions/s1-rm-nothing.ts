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
 * Known window: a background process could create a target between this check
 * and the spawn. rm would then remove a file that appeared in those
 * milliseconds; the agent's own tool calls are serial, so only its background
 * tasks could race it.
 *
 * Synchronous, never throws.
 */

import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
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
 * "nothing" when `command` is a plain `rm` whose every path is absent;
 * "own-scratch" when every path is absent or an untracked file this session
 * created (and at least one is such a file); null otherwise.
 */
export function rmOfNothingOrOwn(
	command: string,
	cwd: string | undefined,
	created?: CreatedFiles,
): "nothing" | "own-scratch" | null {
	try {
		if (!cwd || !path.isAbsolute(cwd)) return null;
		const text = command.trim();
		if (!PLAIN.test(text)) return null;
		if (promptControlText(text) !== null) return null;
		const rules = decideRules(text);
		if (
			rules.verdict !== "escalate" ||
			rules.rules.length !== 1 ||
			rules.rules[0] !== "rm_non_temp"
		)
			return null;
		const [bin, ...args] = text.split(/ +/);
		if (bin !== "rm") return null;
		const paths = args.filter((a) => !a.startsWith("-"));
		if (args.some((a) => a.startsWith("-") && !FLAG.test(a))) return null;
		if (paths.length === 0 || paths.length > MAX_PATHS) return null;
		const root = realpathSync(cwd);
		const own: string[] = [];
		for (const p of paths) {
			if (p.startsWith("/") || p.split("/").includes("..")) return null;
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
		if (own.length === 0) return "nothing";
		return noneTracked(root, own) ? "own-scratch" : null;
	} catch {
		return null;
	}
}
