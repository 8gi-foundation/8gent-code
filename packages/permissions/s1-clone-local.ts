/**
 * System One: `git clone <local repo> <new dir>` into the workspace (#3826).
 *
 * Pilot env-setup-practice (10 Oct 2026): `git clone ../shared-notes.git notes`
 * (a bare repo beside the project) was blocked by the judge. Same lane as
 * s1-mv-in-project.ts: a deterministic allow, checked before the judge.
 *
 * ok needs ALL of:
 *   - a working directory, absolute;
 *   - the whole command is plain words (same alphabet as the mv lane: no quote,
 *     glob, `$`, backtick, `~`, redirect, pipe, `;`, `&`, newline), no
 *     prompt-control text, and decideRules fired no rule;
 *   - exactly `git clone [-q|--quiet] <src> <dest>`. Every other flag is
 *     refused, so --upload-pack/-u, --config/-c, --template, --recurse-submodules,
 *     --separate-git-dir, --origin, --reference, --filter and `--` never match,
 *     and so does `git -C`/`git -c` before `clone`;
 *   - the source is a LOCAL PATH only: relative (it may use `..`, the pilot's
 *     source is a sibling), no `:` or `@` anywhere (so https://, ssh://, git@host:,
 *     file:// and host:path are all refused), not starting with `-`, no `.git`
 *     segment as written, no empty or `.` segment;
 *   - the source exists, is a real directory (not a symlink), and its real path
 *     is inside the workspace or inside the workspace's parent directory (a
 *     sibling such as ../shared-notes.git); nothing further out is read;
 *   - the source is a git repository: a bare one (HEAD file plus objects/ and
 *     refs/) or a work tree whose .git is a real directory (not a file or
 *     symlink, so no gitdir: redirect);
 *   - the destination is relative, plain, with no `..`/`.`/`.git` segment, does
 *     NOT exist (lstat, so a dangling link counts), its parent is a real
 *     directory inside the workspace with no dot segment, it is not inside the
 *     source, its name is not protected, and it is not under packages/permissions,
 *     packages/decide or hooks.
 *
 * Not covered on purpose: URLs of any kind, absolute sources, symlinked sources
 * or parents, existing destinations, every clone flag but -q/--quiet.
 *
 * Known window, same as s1-mv-in-project.ts: a process of this uid could swap a
 * directory for a symlink between this check and the spawn.
 *
 * Synchronous, never throws.
 */

import { lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { promptControlText } from "../decide/guard";
import { decideRules } from "../decide/rules";
import {
	lstatOrNull,
	plainRelative,
	protectedName,
	protectedRel,
	stripDot,
} from "./s1-mv-in-project";
import { inside } from "./s1-rm-nothing";

const PLAIN = /^[A-Za-z0-9._/+,=@: -]+$/;
const CLONE_FLAG = /^(-q|--quiet)$/;

export type CloneLocal = { ok: true; reason: string } | { ok: false };

const NO: CloneLocal = { ok: false };

function isDir(p: string): boolean {
	const st = lstatOrNull(p);
	return !!st && st.isDirectory() && !st.isSymbolicLink();
}

/** A bare repository (HEAD, objects/, refs/) or a work tree with a real .git directory. */
function looksLikeRepo(dir: string): boolean {
	if (isDir(path.join(dir, ".git"))) return true;
	const head = lstatOrNull(path.join(dir, "HEAD"));
	return (
		!!head &&
		head.isFile() &&
		isDir(path.join(dir, "objects")) &&
		isDir(path.join(dir, "refs"))
	);
}

export function cloneLocalIntoProject(command: string, cwd: string | undefined): CloneLocal {
	try {
		if (!cwd || !path.isAbsolute(cwd)) return NO;
		const text = command.trim();
		if (!PLAIN.test(text) || promptControlText(text) !== null) return NO;
		const words = text.split(/ +/);
		if (words[0] !== "git" || words[1] !== "clone") return NO;
		if (decideRules(text).rules.length !== 0) return NO;
		const args = words.slice(2);
		const flags = args.filter((a) => a.startsWith("-"));
		const operands = args.filter((a) => !a.startsWith("-")).map(stripDot);
		if (flags.some((f) => !CLONE_FLAG.test(f))) return NO;
		if (operands.length !== 2) return NO;
		const [srcArg, destArg] = operands;
		// Local path only: a scheme, user@host or host:path always has `:` or `@`.
		if (/[:@]/.test(srcArg) || /[:@]/.test(destArg)) return NO;
		const srcSegs = srcArg.replace(/\/+$/, "").split("/");
		if (
			!srcArg ||
			srcArg.startsWith("/") ||
			srcSegs.some((s) => s === "" || s === "." || s.toLowerCase() === ".git")
		)
			return NO;
		if (!plainRelative(destArg) || destArg.endsWith("/")) return NO;

		const root = realpathSync(cwd);
		const srcAbs = path.resolve(root, srcArg);
		const st = lstatOrNull(srcAbs);
		if (!st || st.isSymbolicLink() || !st.isDirectory()) return NO;
		const realSrc = realpathSync(srcAbs);
		const parentOfRoot = path.dirname(root);
		if (!(inside(realSrc, root) || inside(realSrc, parentOfRoot)) || realSrc === parentOfRoot) return NO;
		if (!looksLikeRepo(realSrc)) return NO;

		const destAbs = path.resolve(root, destArg);
		if (!inside(destAbs, root) || destAbs === root) return NO;
		if (lstatOrNull(destAbs)) return NO;
		const realParent = realpathSync(path.dirname(destAbs));
		if (!inside(realParent, root)) return NO;
		const finalAbs = path.join(realParent, path.basename(destAbs));
		const relParent = path.relative(root, realParent);
		if (relParent.split("/").some((s) => s.startsWith("."))) return NO;
		if (protectedName(path.basename(finalAbs))) return NO;
		if (protectedRel(path.relative(root, finalAbs))) return NO;
		if (inside(finalAbs, realSrc)) return NO;
		return { ok: true, reason: "git clone of a local repository into a new directory inside the workspace" };
	} catch {
		return NO;
	}
}
