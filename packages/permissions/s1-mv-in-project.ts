/**
 * System One: a plain `mv` that stays inside the workspace (#3809).
 *
 * Pilot env-setup-practice (10 Oct 2026, classifier v7, 3 of 3 failed): the
 * prompt was "organise the loose files in inbox/ into folders by type. Nothing
 * gets deleted." The task needs `mv inbox/note-1.txt inbox/notes/`. No rule
 * fires for `mv` of ordinary names (decideRules returns allow with no rules),
 * so the command went to the model judge, which scored it pYes 0.49 to 0.70
 * and blocked it, while the same shape with `doc-1.md` passed. The model then
 * fell back to cp plus rm (denied) or a helper script. The judge has no
 * filesystem to look at; this module does.
 *
 * `moveInProject` answers ok only when every endpoint of the move is provably
 * inside the workspace and nothing is overwritten. Then the judge is not
 * asked. Anything else keeps today's behaviour (rules, then the judge).
 *
 * ok needs ALL of:
 *   - a working directory, absolute;
 *   - the whole command is words of [A-Za-z0-9._/+,=@:-] separated by spaces:
 *     no quotes, glob, brace, `$`, backtick, `~`, redirect, pipe, `;`, `&`,
 *     `#`, newline (so a variable or glob target is never covered); no
 *     prompt-control text; and decideRules fired no rule;
 *   - the first word is `mv` (or `git mv`, #3826; several sources are fine when
 *     the destination is an existing directory), flags only -n / -v / -f (no -i, -t, -T, `--`);
 *     -f changes nothing outside because the landing path must not exist
 *     anyway (#3943);
 *   - at least two operands, every one relative with no `..` segment, no `.`
 *     operand, and no `.git` segment as written;
 *   - every source exists as a regular file or a real directory (not a
 *     symlink), its real parent is inside the real workspace, and the real
 *     relative path has no `.git` segment; a directory that holds a `.git`
 *     (a nested repository) is not moved;
 *   - the destination is either an existing real directory inside the
 *     workspace (not a symlink), or, with exactly one source, a new name whose
 *     parent is such a directory;
 *   - nothing is overwritten: the final path of every source (destination
 *     directory plus its base name, or the new name) must not exist, checked
 *     with lstat so a dangling symlink and a case-insensitive twin count;
 *   - no endpoint name is protected: no name starting with `.` (dotfiles,
 *     .env, .git, .claude) except a plain generated-data file such as
 *     `.todo-e2e.json` (one dot, a stem, .json, not a config
 *     name) and a leading `.tmp` directory (#3943), no dependency lockfile or project manifest, no
 *     key, certificate or database file;
 *   - no landing name configures or runs tooling by itself (*.config.js,
 *     bunfig.toml, tsconfig*.json, conftest.py, setup.py, *.sh, git hook
 *     names), and none starts with credential, secret or id_;
 *   - nothing under packages/permissions, packages/decide or hooks moves or
 *     receives a move;
 *   - a moved directory holds no dot entry, protected name or protected path
 *     anywhere below it, and no more than 2000 entries;
 *   - a directory is not moved into itself.
 *
 * Also (#4073): `cp [-n] [-v] <file>... <dest>` under the same endpoint rules,
 * for regular files only (no -r, no directories, no symlinks), and a glob
 * (`*` or `?`) in the last segment of a source, expanded here the way the shell
 * would (sorted, never a dotfile, never a name starting with `-`, at least one
 * match, at most 200, each match then checked as a written operand). The
 * pilot's `mv inbox/note-*.txt inbox/notes/` is this case.
 *
 * Not covered on purpose: moves that leave the workspace or arrive from
 * outside it, overwrites (a move over an existing file always reaches the
 * judge), variables and any other glob form, symlink endpoints, more sources than a
 * directory destination can hold without a clash, and any `-t` form.
 *
 * Known window, the same as s1-rm-single.ts: a process of this uid could swap
 * a directory for a symlink between this check and the spawn.
 *
 * Synchronous, never throws.
 */

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { promptControlText } from "../decide/guard";
import { decideRules } from "../decide/rules";
import { accountHome } from "./s1-account-home";
import { protectedDataRoots } from "./run-command-sandbox";
import { inside } from "./s1-rm-nothing";

const PLAIN = /^[A-Za-z0-9._/+,=@: -]+$/;
const MV_FLAG = /^-[nvf]+$/;
/** cp copies files only: no -r/-R/-a (trees), -f, -L/-H/-P (link following), -p, -i, -t, -T. */
const CP_FLAG = /^-[nv]+$/;
/** A glob is `*` or `?` in the LAST segment of a source only; nothing else is expanded (#4073). */
const GLOB_PLAIN = /^[A-Za-z0-9._/+,=@:*? -]+$/;
/** Most files one glob may expand to before the command goes to review. */
const MAX_GLOB = 200;
/** Dependency lockfiles and project manifests: project state, never moved without review (lower-cased). */
const PROTECTED_NAMES = new Set([
	"bun.lock",
	"bun.lockb",
	"yarn.lock",
	"cargo.lock",
	"cargo.toml",
	"gemfile.lock",
	"gemfile",
	"poetry.lock",
	"uv.lock",
	"pdm.lock",
	"composer.lock",
	"composer.json",
	"mix.lock",
	"pubspec.lock",
	"podfile.lock",
	"flake.lock",
	"deno.lock",
	"package.json",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"pyproject.toml",
	"go.mod",
	"go.sum",
	"makefile",
	"dockerfile",
	// Instruction files an assistant reads as orders (8SO, #3827).
	"claude.md",
	"agents.md",
	"gemini.md",
]);
/**
 * ONE sensitive-name set for the mv and rm lanes (#3944): the union of what each
 * had, plus .env*, .npmrc, .netrc and credential/secret anywhere in the name.
 */
export const SENSITIVE_NAME =
	/^\.env(\.|$)|^\.(npmrc|netrc)$|\.(pem|key|p12|db)$|\.sqlite|^id_|credential|secret/i;
/** Names that run or configure tooling on their own (bun, jest, pytest, git hooks): never a landing name. */
const AUTO_EXEC_NAME =
	/\.config\.[cm]?[jt]s$|^bunfig\.toml$|^tsconfig[\w.-]*\.json$|^(conftest\.py|setup\.py|setup\.cfg|justfile|pre-commit|pre-push|commit-msg|post-[\w-]+)$|\.sh$/i;
/**
 * True when a workspace-relative path has a dot segment other than a leading
 * `.tmp` directory or a final generated-data file name.
 */
function badDot(rel: string): boolean {
	const segs = relSegments(rel);
	return segs.some((seg, i) => {
		if (!seg.startsWith(".")) return false;
		if (seg === ".tmp" && i === 0) return false;
		return !(i === segs.length - 1 && generatedDataName(seg));
	});
}

/** Security-bearing source: never moved, never a landing place (workspace-relative). */
const PROTECTED_PREFIXES = ["packages/permissions", "packages/decide", "hooks"];
/** Most entries a moved directory may hold before it goes to review. */
export const MAX_TREE = 2000;

export type MoveInProject = { ok: true; reason: string } | { ok: false };

const NO: MoveInProject = { ok: false };

/**
 * A data file a task writes for itself (`e2e.json`, `.todo-e2e.json`,
 * `.tmp/result.json`): a POSITIVE allowlist (8SO, #3944). The stem, split on
 * `.`, `-` and `_`, must contain a token that is exactly e2e, todo, tmp, out
 * or result (optionally plural and numbered), must not end in `rc` or
 * `config`, and the name must end in .json with at most one leading dot.
 * Tooling config such as .mocharc.json, nodemon.json, ecosystem.config.json,
 * wrangler.json or bower.json has none of those tokens, so it never matches,
 * and the protected, sensitive and auto-exec name lists still apply on top.
 * Only file endpoints may use it, never a directory or a tree.
 */
const GEN_TOKEN = /^(?:e2e|todo|tmp|out|result)s?\d*$/;
const CONFIG_STEM = /(?:rc|config)$/i;

export function generatedDataName(name: string): boolean {
	if (!/\.json$/i.test(name)) return false;
	const stem = name.slice(name.startsWith(".") ? 1 : 0, -".json".length);
	if (stem === "" || stem.startsWith(".") || !/^[A-Za-z0-9._-]+$/.test(stem)) return false;
	if (CONFIG_STEM.test(stem)) return false;
	if (!stem.toLowerCase().split(/[._-]+/).some((t) => GEN_TOKEN.test(t))) return false;
	return !(
		PROTECTED_NAMES.has(name.toLowerCase()) ||
		SENSITIVE_NAME.test(name) ||
		AUTO_EXEC_NAME.test(name)
	);
}

/** A non-dot .json name that is not tooling config: allowed to sit in .tmp/ for the rm lane. */
export function plainJsonName(name: string): boolean {
	if (!/\.json$/i.test(name) || name.startsWith(".")) return false;
	if (CONFIG_STEM.test(name.slice(0, -".json".length))) return false;
	return !(
		PROTECTED_NAMES.has(name.toLowerCase()) ||
		SENSITIVE_NAME.test(name) ||
		AUTO_EXEC_NAME.test(name) ||
		CONFIG_JSON.test(name)
	);
}
/** Well-known tooling .json names; plainJsonName is only used under .tmp/, where this is defence in depth. */
const CONFIG_JSON =
	/^(?:nodemon|bower|composer|manifest|deno|jsr|biome|components|vercel|firebase|turbo|nx|lerna|renovate|app|eas|wrangler|jsconfig|cspell|lighthouse|tslint|jest|babel|tailwind|postcss|vite|pyrightconfig|ecosystem)[\w.-]*\.json$/i;

export function protectedName(name: string, fileEndpoint = false): boolean {
	return (
		(name.startsWith(".") && !(fileEndpoint && generatedDataName(name))) ||
		PROTECTED_NAMES.has(name.toLowerCase()) ||
		SENSITIVE_NAME.test(name) ||
		AUTO_EXEC_NAME.test(name)
	);
}

/** Platforms whose file systems fold case by default: a differently-cased path is the same path. */
const CASE_FOLDING = new Set<NodeJS.Platform>(["win32", "darwin"]);

/**
 * The segments of a workspace-relative path as path.relative() produced it on
 * `platform`: split on both separators on win32 (backslash, and the "/" an
 * operand was written with), on "/" elsewhere. Exported for the cross-OS tests.
 */
export function relSegments(rel: string, platform: NodeJS.Platform = process.platform): string[] {
	return platform === "win32" ? rel.split(/[\\/]/) : rel.split("/");
}

/** True when any segment of `rel` is a dot entry (.git, .claude, .env, ...). */
export function hasDotSegment(rel: string, platform: NodeJS.Platform = process.platform): boolean {
	return relSegments(rel, platform).some((s) => s.startsWith("."));
}

/** Security-bearing path: equal to, below, or a parent of a protected prefix. Case-folded on win32 and darwin. */
export function protectedRel(relIn: string, platform: NodeJS.Platform = process.platform): boolean {
	let rel = relSegments(relIn, platform).join("/");
	if (CASE_FOLDING.has(platform)) rel = rel.toLowerCase();
	return PROTECTED_PREFIXES.some(
		(p) => rel === p || rel.startsWith(`${p}/`) || p.startsWith(`${rel}/`),
	);
}

/**
 * Windows names that mean something other than what they spell: an alternate
 * data stream (`a:b`), a trailing dot or space (`hooks.` is `hooks`), and an
 * 8.3 short name (`PACKAGE~1` is `packages`). Refused outright on win32 so none
 * of them can reach a protected path unseen; never true elsewhere.
 */
export function windowsAliasOperand(operand: string, platform: NodeJS.Platform = process.platform): boolean {
	if (platform !== "win32") return false;
	return (
		operand.includes(":") ||
		/~\d/.test(operand) ||
		operand
			.split(/[\\/]/)
			.some((seg) => seg !== "" && seg !== "." && seg !== ".." && /[. ]$/.test(seg))
	);
}

/** True when a directory tree holds a dot entry, a protected name, a protected path or too many entries. */
function treeNeedsReview(dir: string, root: string): boolean {
	let count = 0;
	const walk = (d: string): boolean => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			if (++count > MAX_TREE) return true;
			if (protectedName(e.name)) return true;
			const abs = path.join(d, e.name);
			if (protectedRel(path.relative(root, abs))) return true;
			if (e.isDirectory() && walk(abs)) return true;
		}
		return false;
	};
	return walk(dir);
}

export function lstatOrNull(p: string): ReturnType<typeof lstatSync> | null {
	try {
		return lstatSync(p);
	} catch {
		return null;
	}
}

/** A relative operand with no `..`, no `.`, no `.git` and no empty segment as written. */
export function plainRelative(p: string): boolean {
	if (!p || p.startsWith("/") || p.startsWith("-")) return false;
	return p
		.replace(/\/+$/, "")
		.split("/")
		.every((s) => s !== "" && s !== "." && s !== ".." && s.toLowerCase() !== ".git");
}

/** A leading "./" is harmless, and the operand is then still checked as written. */
export function stripDot(p: string): string {
	return p.startsWith("./") ? p.slice(2) : p;
}

/**
 * Replace a `*`/`?` in the last segment of a source operand of `mv`/`cp` with
 * the names it matches, or return null (no opinion). Pure shell semantics for
 * the simple case only: the directory part has no glob, the flags and the
 * destination have none, dotfiles never match, and nothing starting with `-`
 * is produced. Every produced name is then checked as a written operand.
 */
function expandGlobs(text: string, cwd: string): string | null {
	if (process.platform === "win32" || !GLOB_PLAIN.test(text)) return null;
	const words = text.split(/ +/);
	if (words[0] !== "mv" && words[0] !== "cp") return null;
	const args = words.slice(1);
	const isOperand = (a: string) => !a.startsWith("-");
	const operands = args.filter(isOperand);
	if (operands.length < 2) return null;
	if (/[*?]/.test(operands[operands.length - 1])) return null;
	if (args.some((a) => !isOperand(a) && /[*?]/.test(a))) return null;
	const root = realpathSync(cwd);
	if (inProtectedDataRoot(root)) return null;
	const out: string[] = [words[0]];
	let globs = 0;
	for (const a of args) {
		if (!isOperand(a) || !/[*?]/.test(a)) {
			out.push(a);
			continue;
		}
		if (++globs > 1) return null;
		const op = stripDot(a);
		const cut = op.lastIndexOf("/");
		const dir = cut < 0 ? "" : op.slice(0, cut);
		const pat = op.slice(cut + 1);
		// A leading dot in the pattern would match dotfiles by hand: no opinion.
		if (/[*?]/.test(dir) || pat === "" || pat.startsWith(".") || !plainRelative(dir === "" ? "x" : dir))
			return null;
		const dirAbs = realpathSync(path.resolve(root, dir));
		if (!inside(dirAbs, root)) return null;
		// `s`: `*` and `?` match newline and CR as in the shell; `u`: one code point, astral included.
		const re = new RegExp(
			`^${pat.replace(/[.+]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
			"su",
		);
		const names = readdirSync(dirAbs)
			.filter((n) => !n.startsWith(".") && re.test(n))
			.sort();
		if (names.length === 0 || names.length > MAX_GLOB) return null;
		// Every entry the shell would match must be a plain word. One odd name (flag-like,
		// spaced, newline, non-ASCII) means the shell would hand mv something this lane cannot
		// write back as words, so the whole command goes to the judge.
		if (names.some((n) => n.startsWith("-") || !PLAIN_NAME.test(n))) return null;
		for (const n of names) out.push(dir === "" ? n : `${dir}/${n}`);
	}
	return globs === 1 ? out.join(" ") : null;
}

/** A name that survives being written back into a space-separated command. */
const PLAIN_NAME = /^[A-Za-z0-9._+,=@:-]+$/;

/**
 * True when `root` (a real path) is inside any protected data root
 * (`protectedDataRoots()`: ~/.8gent, EIGHT_HOME's .8gent, EIGHT_DATA_DIR), where
 * globs never expand on trust. The one exception is a pilot run directory under
 * the DEFAULT `~/.8gent/rishi-pilot/runs/`, which is an ordinary workspace.
 */
function inProtectedDataRoot(root: string): boolean {
	const defaults = new Set<string>();
	for (const h of [accountHome(), process.env.HOME]) {
		if (!h) continue;
		defaults.add(path.join(h, ".8gent"));
		try {
			defaults.add(path.join(realpathSync(h), ".8gent"));
		} catch {
			// not resolvable: keep the written form
		}
	}
	const roots = new Set<string>();
	for (const r of [...protectedDataRoots(), ...defaults]) {
		roots.add(r);
		try {
			roots.add(realpathSync(r));
		} catch {
			// missing: keep the written form
		}
	}
	for (const data of roots) {
		if (!inside(root, data)) continue;
		if (defaults.has(data)) {
			const runs = path.join(data, "rishi-pilot", "runs");
			if (root !== runs && inside(root, runs)) continue;
		}
		return true;
	}
	return false;
}

/**
 * ok when `command` is `mv` or `git mv`, `[-n] [-v] <src>... <dest>`, with every endpoint
 * inside `cwd` and nothing overwritten; see the header for every condition.
 */
export function moveInProject(command: string, cwd: string | undefined): MoveInProject {
	try {
		if (!cwd || !path.isAbsolute(cwd)) return NO;
		let text = command.trim();
		if (/[*?]/.test(text)) {
			const expanded = expandGlobs(text, cwd);
			if (!expanded) return NO;
			text = expanded;
		}
		if (!PLAIN.test(text) || promptControlText(text) !== null) return NO;
		const words = text.split(/ +/);
		// `git mv` is the same move through the index (#3826); `git -C`, `git -c`
		// and any other word between `git` and `mv` never match.
		const isGit = words[0] === "git" && words[1] === "mv";
		const isCp = words[0] === "cp";
		if (words[0] !== "mv" && !isGit && !isCp) return NO;
		if (decideRules(text).rules.length !== 0) return NO;
		const args = words.slice(isGit ? 2 : 1);
		const flags = args.filter((a) => a.startsWith("-"));
		const operands = args.filter((a) => !a.startsWith("-")).map(stripDot);
		if (flags.some((f) => !(isCp ? CP_FLAG : MV_FLAG).test(f))) return NO;
		// `git mv -f` overwrites through the index; only plain `mv -f` is covered (#3943).
		if (isGit && flags.some((f) => f.includes("f"))) return NO;
		if (operands.length < 2 || !operands.every(plainRelative)) return NO;
		if (operands.some((o) => windowsAliasOperand(o))) return NO;

		const root = realpathSync(cwd);
		const srcs = operands.slice(0, -1).map((s) => s.replace(/\/+$/, ""));
		const destArg = operands[operands.length - 1];
		const destAbs = path.resolve(root, destArg);
		if (!inside(destAbs, root)) return NO;

		// Where each source will land: [source abs, final abs].
		const moves: Array<[string, string]> = [];
		const destStat = lstatOrNull(destAbs);
		if (destStat) {
			// An existing destination must be a real directory inside the workspace.
			if (!destStat.isDirectory()) return NO;
			const realDest = realpathSync(destAbs);
			if (!inside(realDest, root)) return NO;
			if (badDot(path.relative(root, realDest))) return NO;
			for (const s of srcs)
				moves.push([path.resolve(root, s), path.join(realDest, path.basename(s))]);
		} else {
			// A rename: one source, and no trailing slash (mv would refuse a new directory).
			if (srcs.length !== 1 || destArg.endsWith("/")) return NO;
			const realParent = realpathSync(path.dirname(destAbs));
			if (!inside(realParent, root)) return NO;
			if (badDot(path.relative(root, realParent))) return NO;
			moves.push([path.resolve(root, srcs[0]), path.join(realParent, path.basename(destAbs))]);
		}

		const seen = new Set<string>();
		for (const [srcAbs, finalAbs] of moves) {
			if (!inside(srcAbs, root) || srcAbs === root) return NO;
			const st = lstatOrNull(srcAbs);
			if (!st || st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) return NO;
			// cp copies single regular files only; a directory needs -r and review.
			if (isCp && !st.isFile()) return NO;
			const realParent = realpathSync(path.dirname(srcAbs));
			if (!inside(realParent, root)) return NO;
			const realSrc = path.join(realParent, path.basename(srcAbs));
			const relSrc = path.relative(root, realSrc);
			if (badDot(relSrc)) return NO;
			if (protectedRel(relSrc) || protectedRel(path.relative(root, finalAbs))) return NO;
			const isFile = st.isFile();
			// Any .json endpoint must be a generated-data name: json is where tooling config hides.
			for (const n of [path.basename(realSrc), path.basename(finalAbs)])
				if (isFile && /\.json$/i.test(n) && !generatedDataName(n)) return NO;
			if (
				protectedName(path.basename(realSrc), isFile) ||
				protectedName(path.basename(finalAbs), isFile)
			)
				return NO;
			// A generated-data dotfile may only land under .tmp or beside itself, never as a hidden config.
			if (badDot(path.relative(root, finalAbs))) return NO;
			if (st.isDirectory()) {
				// A tree holding a repository, a dotfile, a protected name or path, or
				// too many entries carries them along unchecked: review it.
				if (treeNeedsReview(realSrc, root)) return NO;
				// A directory cannot move into itself.
				if (inside(finalAbs, realSrc)) return NO;
			}
			// Never overwrite: the landing path must be free (lstat sees dangling links).
			if (lstatOrNull(finalAbs)) return NO;
			// Two sources with one base name would clash with each other.
			const key = finalAbs.toLowerCase();
			if (seen.has(key)) return NO;
			seen.add(key);
		}
		return {
			ok: true,
			reason: `${isGit ? "git mv" : isCp ? "cp" : "mv"} of ${moves.length === 1 ? "one path" : `${moves.length} paths`} inside the workspace, nothing overwritten`,
		};
	} catch {
		return NO;
	}
}
