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
 *   - the source is a LOCAL PATH only: relative, no `:` or `@` anywhere (so
 *     https://, ssh://, git@host:, file:// and host:path are all refused), not
 *     starting with `-`, no empty, `.` or dot-leading segment other than the
 *     single leading `..` of the sibling form;
 *   - the source is a real directory (not a symlink) and is either (a) a
 *     repository inside the workspace, or (b) written exactly `../<name>`, a
 *     BARE repository (HEAD, objects/, refs/ at its root, no .git) that is a
 *     sibling of the workspace, where the workspace parent is not `/`, not
 *     $HOME and not an ancestor of $HOME (compared case-insensitively);
 *     everything else falls through;
 *   - the source's tracked tree (git ls-tree -r HEAD, run without a shell
 *     under a short timeout) holds no symlink; if the scan cannot run, refuse;
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

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
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
/** Dependency, install and build output directories: never a clone destination at any depth (lower-cased). */
const INSTALL_DIRS = new Set([
	"node_modules",
	"vendor",
	"venv",
	".venv",
	"dist",
	"build",
	"bower_components",
	"jspm_packages",
	"site-packages",
	"pods",
	".pnpm",
	".yarn",
]);
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

/** True when `dir` has no symlink in its tracked tree. False when the scan cannot run. */
function noTrackedSymlinks(dir: string): boolean {
	try {
		const out = execFileSync("git", ["-C", dir, "ls-tree", "-r", "HEAD"], {
			encoding: "utf8",
			timeout: 5000,
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", HOME: "/nonexistent" },
		});
		return !out.split("\n").some((l) => l.startsWith("120000"));
	} catch {
		return false;
	}
}

function bareRepo(dir: string): boolean {
	const head = lstatOrNull(path.join(dir, "HEAD"));
	return (
		!!head &&
		head.isFile() &&
		isDir(path.join(dir, "objects")) &&
		isDir(path.join(dir, "refs")) &&
		!lstatOrNull(path.join(dir, ".git"))
	);
}

/** The workspace parent is a shared place: refuse `/`, $HOME and any ancestor of $HOME. */
function parentIsTooBroad(parent: string): boolean {
	const p = parent.toLowerCase();
	if (p === "/" || p === path.parse(parent).root.toLowerCase()) return true;
	const homes = new Set<string>();
	const add = (h: string | undefined) => {
		if (!h) return;
		homes.add(h.toLowerCase());
		// Resolve the nearest existing ancestor so /var and /private/var compare equal.
		let cur = h;
		let rest = "";
		for (let i = 0; i < 64 && cur !== path.dirname(cur); i++) {
			try {
				homes.add(path.join(realpathSync(cur), rest).toLowerCase());
				break;
			} catch {
				rest = path.join(path.basename(cur), rest);
				cur = path.dirname(cur);
			}
		}
	};
	add(process.env.HOME);
	add(homedir());
	for (const h of homes) if (h === p || h.startsWith(p.endsWith("/") ? p : `${p}/`)) return true;
	return false;
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
		if (!srcArg || srcArg.startsWith("/")) return NO;
		const sibling = srcSegs[0] === "..";
		if (sibling) {
			// Exactly `../<name>`.
			if (srcSegs.length !== 2) return NO;
			if (srcSegs[1] === "" || srcSegs[1].startsWith(".")) return NO;
		} else if (srcSegs.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."))) {
			return NO;
		}
		if (!plainRelative(destArg) || destArg.endsWith("/")) return NO;

		const root = realpathSync(cwd);
		const srcAbs = path.resolve(root, srcArg);
		const st = lstatOrNull(srcAbs);
		if (!st || st.isSymbolicLink() || !st.isDirectory()) return NO;
		const realSrc = realpathSync(srcAbs);
		const parentOfRoot = path.dirname(root);
		if (sibling) {
			if (parentIsTooBroad(parentOfRoot)) return NO;
			if (realSrc.toLowerCase() !== path.join(parentOfRoot, srcSegs[1]).toLowerCase()) return NO;
			if (!bareRepo(realSrc)) return NO;
		} else {
			if (!inside(realSrc, root) || realSrc === root) return NO;
			if (!looksLikeRepo(realSrc)) return NO;
		}
		if (!noTrackedSymlinks(realSrc)) return NO;

		const destAbs = path.resolve(root, destArg);
		if (!inside(destAbs, root) || destAbs === root) return NO;
		if (lstatOrNull(destAbs)) return NO;
		const realParent = realpathSync(path.dirname(destAbs));
		if (!inside(realParent, root)) return NO;
		const finalAbs = path.join(realParent, path.basename(destAbs));
		const relParent = path.relative(root, realParent);
		if (relParent.split("/").some((s) => s.startsWith("."))) return NO;
		if (path.relative(root, finalAbs).split("/").some((seg) => INSTALL_DIRS.has(seg.toLowerCase()))) return NO;
		if (protectedName(path.basename(finalAbs))) return NO;
		if (protectedRel(path.relative(root, finalAbs))) return NO;
		if (inside(finalAbs, realSrc)) return NO;
		return { ok: true, reason: "git clone of a local repository into a new directory inside the workspace" };
	} catch {
		return NO;
	}
}
