/**
 * System One: restoring a tracked file from git history inside the project (#3840).
 *
 * Pilot troubleshoot-practice (10 Oct 2026, main 773815be, FAIL 18/19): the
 * correct fix was `git show 906ce37:config/rates.json > config/rates.json`,
 * which puts a tracked config file back to its last good commit. The model
 * judge scored it pYes 0.5082 and blocked it. The judge has no filesystem or
 * repository to look at; this module does. The restore is reversible through
 * git and touches one tracked file the repository already holds.
 *
 * `restoreInProject` answers ok only for these three shapes:
 *   git show <rev>:<path> > <path>
 *   git restore [--source=<rev>] [--] <path>...
 *   git checkout [<rev>] -- <path>...
 * Anything else is "not allowed by this lane", never a block: it falls through
 * to the rules and the judge unchanged.
 *
 * ok needs ALL of:
 *   - a working directory, absolute, that is a git work tree (its realpath is
 *     the tree root);
 *   - one simple command: words of [A-Za-z0-9._/+,=@~:-] separated by spaces
 *     (plus, for `git show`, exactly one ` > ` redirect with one target): no
 *     quote, glob, brace, `$`, backtick, `;`, `&`, `|`, `(`, `)`, `<`, `>>`,
 *     `#`, newline, heredoc; no prompt-control text; no rule but those two discard rules fired;
 *   - no option except `--source=<rev>` (restore) and the one `--` separator;
 *     no word starting with `-` in a path or rev slot, no second `--`;
 *   - <rev> is a plain ref, sha or HEAD~n (no `..`, `^`, `@{`, `:`), and git
 *     resolves it to a commit;
 *   - every path is relative with no `..`, `.`, empty or dot segment (so no
 *     `.git`, `.env`, `.claude`), no trailing slash;
 *   - every target matches HEAD (no staged or unstaged edit), so the overwrite
 *     discards nothing git cannot give back; this is what lets the lane pass
 *     the git_restore_discards_changes and git_checkout_discards_changes
 *     rules, and no other rule may fire;
 *   - every target is a regular file (lstat: not a symlink), its real parent
 *     is inside the real work tree, and it is tracked in the index;
 *   - no target is security-bearing: nothing under packages/permissions,
 *     packages/decide or hooks, no key, certificate, database, credential or
 *     tooling-config name;
 *   - for `git show`, the redirect target is the same path as the one named in
 *     <rev>:<path>.
 *
 * Not covered on purpose: untracked or missing targets, targets outside the
 * tree, symlinks, `-p`, `--staged`, `--worktree`, `--ours`, `--theirs`,
 * `--output=`, `-b`, `-f`, pathspec magic, globs, `>>`, `> /etc/x`, chaining,
 * and a restore into a different file.
 *
 * Known window, as in s1-mv-in-project.ts: a process of this uid could swap a
 * directory for a symlink between this check and the spawn.
 *
 * Synchronous, never throws.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { promptControlText } from "../decide/guard";
import { decideRules } from "../decide/rules";
import { inside } from "./s1-rm-nothing";

const WORDS = /^[A-Za-z0-9._/+,=@~: -]+$/;
const REV = /^(?:[A-Za-z0-9][A-Za-z0-9._/+-]*)(?:~[0-9]{1,4})?$/;
const SENSITIVE_NAME = /\.(pem|key|p12|db)$|\.sqlite|^(credential|secret|id_)/i;
const AUTO_EXEC_NAME =
	/\.config\.[cm]?[jt]s$|^bunfig\.toml$|^tsconfig[\w.-]*\.json$|^(conftest\.py|setup\.py|setup\.cfg|justfile|pre-commit|pre-push|commit-msg|post-[\w-]+)$|\.sh$/i;
/** Security-bearing source: never restored (workspace-relative). */
const PROTECTED_PREFIXES = ["packages/permissions", "packages/decide", "hooks"];

/** The only rules this lane may pass over: the clean-target check below answers them. */
const DISCARD_RULES = new Set(["git_restore_discards_changes", "git_checkout_discards_changes"]);

export type RestoreInProject = { ok: true; reason: string } | { ok: false };

const NO: RestoreInProject = { ok: false };

/** git with no inherited repository overrides and no fsmonitor hook; throws on failure. */
function git(root: string, args: string[]): string {
	const env = { ...process.env };
	for (const k of Object.keys(env)) if (k.startsWith("GIT_")) Reflect.deleteProperty(env, k);
	env.GIT_OPTIONAL_LOCKS = "0";
	return execFileSync("git", ["-C", root, "-c", "core.fsmonitor=false", ...args], {
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 5000,
	});
}

function plainRelative(p: string): boolean {
	if (!p || p.startsWith("/") || p.startsWith("-")) return false;
	return p.split("/").every((s) => s !== "" && !s.startsWith("."));
}

function protectedRel(rel: string): boolean {
	return (
		PROTECTED_PREFIXES.some((p) => rel === p || rel.startsWith(`${p}/`)) ||
		SENSITIVE_NAME.test(path.basename(rel)) ||
		AUTO_EXEC_NAME.test(path.basename(rel))
	);
}

/** A leading "./" is harmless, and the path is then still checked as written. */
function stripDot(p: string): string {
	return p.startsWith("./") ? p.slice(2) : p;
}

/** True when `rel` is a tracked regular file (no symlink) whose real parent is inside `root`. */
function trackedRegularFile(root: string, rel: string): boolean {
	if (!plainRelative(rel) || protectedRel(rel)) return false;
	const abs = path.resolve(root, rel);
	if (!inside(abs, root) || abs === root) return false;
	const st = lstatSync(abs);
	if (!st.isFile() || st.isSymbolicLink()) return false;
	const realParent = realpathSync(path.dirname(abs));
	if (!inside(realParent, root)) return false;
	if (path.relative(root, path.join(realParent, path.basename(abs))) !== rel) return false;
	git(root, ["ls-files", "--error-unmatch", "--", rel]);
	return true;
}

function commitExists(root: string, rev: string): boolean {
	if (!REV.test(rev) || rev.includes("..")) return false;
	git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
	return true;
}

/**
 * ok when `command` is one of the three restore shapes in the header, on
 * tracked files inside the work tree at `cwd`.
 */
export function restoreInProject(command: string, cwd: string | undefined): RestoreInProject {
	try {
		if (!cwd || !path.isAbsolute(cwd)) return NO;
		let text = command.trim();
		if (promptControlText(text) !== null) return NO;
		if (decideRules(text).rules.some((r) => !DISCARD_RULES.has(r))) return NO;

		let redirect: string | null = null;
		const parts = text.split(" > ");
		if (parts.length === 2) {
			text = parts[0];
			redirect = stripDot(parts[1]);
		} else if (parts.length !== 1) return NO;
		if (!WORDS.test(text) || (redirect !== null && !WORDS.test(redirect))) return NO;
		if (redirect !== null && /\s/.test(redirect)) return NO;
		const words = text.split(/ +/);
		if (words[0] !== "git") return NO;
		const sub = words[1];
		const args = words.slice(2);

		const root = realpathSync(cwd);
		if (realpathSync(git(root, ["rev-parse", "--show-toplevel"]).trim()) !== root) {
			// cwd may be a subdirectory of the tree: paths are relative to it, so refuse.
			return NO;
		}
		if (git(root, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") return NO;

		let paths: string[];
		if (sub === "show") {
			if (redirect === null || args.length !== 1) return NO;
			const m = /^([^:]+):([^:]+)$/.exec(args[0]);
			if (!m) return NO;
			const rev = m[1];
			const target = stripDot(m[2]);
			if (!commitExists(root, rev) || target !== redirect) return NO;
			paths = [target];
		} else if (sub === "restore" || sub === "checkout") {
			if (redirect !== null) return NO;
			let i = 0;
			let rev: string | null = null;
			if (sub === "restore") {
				if (args[0]?.startsWith("--source=")) {
					rev = args[0].slice("--source=".length);
					i = 1;
				}
				if (args[i] === "--") i++;
			} else {
				if (args[0] !== "--" && args[0] !== undefined && !args[0].startsWith("-")) {
					rev = args[0];
					i = 1;
				}
				if (args[i] !== "--") return NO;
				i++;
			}
			if (rev !== null && !commitExists(root, rev)) return NO;
			const rest = args.slice(i);
			if (rest.length === 0 || rest.some((p) => p.startsWith("-") || p.includes(":"))) return NO;
			paths = rest.map(stripDot);
		} else return NO;

		for (const p of paths) if (!trackedRegularFile(root, p)) return NO;
		// Overwriting loses nothing only when every target already matches HEAD
		// (no staged or unstaged edit): git diff exits 1 on a difference, which throws.
		git(root, ["diff", "--quiet", "HEAD", "--", ...paths]);
		return {
			ok: true,
			reason: `git ${sub} of ${paths.length === 1 ? "one tracked file" : `${paths.length} tracked files`} inside the work tree, restored from history`,
		};
	} catch {
		return NO;
	}
}
