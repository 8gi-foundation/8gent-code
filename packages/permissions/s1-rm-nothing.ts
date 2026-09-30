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
 * Deliberately not allowed: removing any file that exists, even one this
 * session created. That needs a per-session record of created files and is
 * out of scope here.
 *
 * Known window: a background process could create a target between this check
 * and the spawn. rm would then remove a file that appeared in those
 * milliseconds; the agent's own tool calls are serial, so only its background
 * tasks could race it.
 *
 * Synchronous, never throws.
 */

import { lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { promptControlText } from "../decide/guard";
import { decideRules } from "../decide/rules";

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

/** True when `command` is a plain `rm` of paths that do not exist under `cwd`. */
export function rmOfNothing(command: string, cwd: string | undefined): boolean {
	try {
		if (!cwd || !path.isAbsolute(cwd)) return false;
		const text = command.trim();
		if (!PLAIN.test(text)) return false;
		if (promptControlText(text) !== null) return false;
		const rules = decideRules(text);
		if (
			rules.verdict !== "escalate" ||
			rules.rules.length !== 1 ||
			rules.rules[0] !== "rm_non_temp"
		)
			return false;
		const [bin, ...args] = text.split(/ +/);
		if (bin !== "rm") return false;
		const paths = args.filter((a) => !a.startsWith("-"));
		if (args.some((a) => a.startsWith("-") && !FLAG.test(a))) return false;
		if (paths.length === 0 || paths.length > MAX_PATHS) return false;
		const root = realpathSync(cwd);
		for (const p of paths) {
			if (p.startsWith("/") || p.split("/").includes("..")) return false;
			const abs = path.resolve(root, p);
			if (!inside(abs, root)) return false;
			if (!absent(abs)) return false;
			const anchor = nearestExisting(abs);
			if (!anchor || !inside(anchor, root)) return false;
		}
		return true;
	} catch {
		return false;
	}
}
