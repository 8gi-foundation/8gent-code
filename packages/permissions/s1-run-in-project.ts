/**
 * System One: running the project's own script inside the workspace (#3937).
 *
 * Pilot l5-feature-e2e (11 Oct 2026): the model built a small CLI and tested
 * it with `TODO_FILE=/tmp/todo-test.json bun <work>/src/cli.ts done 1`. The
 * judge has no filesystem to look at; it scored that plain command pYes 0.29
 * to 0.45 (escalate, then block in headless runs), because "bun <script>" with
 * an env prefix looks like arbitrary code. The same shape with `done 99` and
 * `done abc` was hit the same way. This module reads the script instead.
 *
 * `runInProject` answers ok only when the command is a plain run of a source
 * file that lives in the workspace and that, with the local files it imports,
 * shows no way to run a program, reach the network, delete, or evaluate text.
 * Then the judge is not asked. Anything else keeps today's behaviour (rules,
 * then the judge). It can only remove a model call, never a rule: a command
 * decideRules flags, or one carrying prompt-control text, is never ok.
 *
 * ok needs ALL of:
 *   - a working directory, absolute;
 *   - the whole command is words of [A-Za-z0-9._/+,=@:-] separated by spaces:
 *     no quotes, glob, `$`, backtick, `~`, redirect, pipe, `;`, `&`, `#`,
 *     newline; no prompt-control text; decideRules fired no rule;
 *   - optional leading NAME=value words (at most 4). NAME is upper case and
 *     not PATH, HOME, SHELL, IFS, ENV, TMPDIR, or any LD_*, DYLD_*, NODE_*,
 *     BUN_*, NPM_*, PYTHON*, BASH*, GIT_*, SSH_* name; a value is a plain
 *     token or a path inside the workspace or under /tmp (/private/tmp), with
 *     no `..`, no secret name, and not an existing symlink;
 *   - then `bun`, `bun run` or `node`, then the script, with no interpreter
 *     flag (so no -e, -p, --eval, --preload, -r, --env-file, --cwd);
 *   - the script is a .ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts regular file, not
 *     a symlink, whose real path is inside the real workspace, with no dot
 *     segment, no protected path (packages/permissions, packages/decide,
 *     hooks) and no secret name;
 *   - the script's arguments are plain words; a flag is a short or long name
 *     not on the interpreter-flag list; any argument with a `/` (also after
 *     `=`) is a path inside the workspace or under /tmp, with no `..`, no
 *     secret name;
 *   - the source of the script and of every relative file it imports (at most
 *     MAX_FILES files and MAX_BYTES bytes, each a regular file inside the
 *     workspace) holds none of the tell-tale text in DANGEROUS (child
 *     processes, Bun.spawn/Bun.$, network, eval, dynamic import or require of
 *     a computed name, rm/unlink/rename/chmod/symlink, secret files, absolute
 *     system paths, env writes). A package import is not followed.
 *
 * Not covered on purpose: python (no import closure here), `bun test` (its own
 * flag), `bun x`, package.json script names, globs and variables, and any
 * script that spawns, fetches, deletes or evals. Known window, the same as
 * s1-rm-single.ts: a file can change between this check and the spawn, and a
 * package from node_modules is trusted as installed.
 *
 * Synchronous, never throws.
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { promptControlText } from "../decide/guard";
import { decideRules } from "../decide/rules";
import { hasDotSegment, protectedRel } from "./s1-mv-in-project";
import { inside } from "./s1-rm-nothing";

const PLAIN = /^[A-Za-z0-9._/+,=@: -]+$/;
const ENV_ASSIGN = /^([A-Z][A-Z0-9_]*)=([A-Za-z0-9._/+,@:-]*)$/;
const ENV_DENY =
	/^(PATH|HOME|SHELL|IFS|ENV|TMPDIR|USER|LOGNAME|CDPATH|(LD|DYLD|NODE|BUN|NPM|PYTHON|BASH|GIT|SSH|XDG)_.*|PYTHON.*|BASH.*)$/;
const MAX_ENV = 4;
const SCRIPT_EXT = /\.(?:[cm]?[jt]sx?)$/;
const TEMP_ROOTS = ["/tmp", "/private/tmp"];
const SECRET =
	/(^|\/)\.env(\.[\w.-]+)?$|(^|\/)\.env\b|id_rsa|id_ed25519|id_ecdsa|(^|\/)\.ssh(\/|$)|\.aws\/|credentials|\.netrc|\.npmrc|\.git-credentials|keychain|\.pem$|\.key$|\.p12$/;
/** Interpreter flags that run text, load code or change the working tree; never accepted as a script flag either. */
const BAD_FLAG =
	/^--?(e|p|r|c|i|eval|print|require|import|preload|loader|env-file|cwd|config|inspect(-brk)?|watch|hot|install|conditions|input-type|experimental[\w-]*|bun|shell|filter|silent|elide-lines|if-present)(=.*)?$/;
const MAX_FILES = 30;
const MAX_BYTES = 400_000;

/** Tell-tale source text that spawns, fetches, deletes, evaluates or reads secrets. */
const DANGEROUS: readonly RegExp[] = [
	/\bchild_process\b/,
	/\bBun\s*\.\s*(?:spawn|spawnSync|\$|which|serve|connect|listen|udpSocket)\b/,
	/from\s+["']bun["']/,
	/\bexecSync?\b|\bexecFileSync?\b|\bspawnSync?\b|\bfork\s*\(/,
	/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b/,
	/["'](?:node:)?(?:https?|http2|net|tls|dgram|dns|cluster|worker_threads|vm|inspector|repl|v8)["']/,
	/\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/,
	/\b(?:import|require)\s*\(\s*(?!["'][^"']+["']\s*\))/,
	/\b(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|chmod|chmodSync|chown|chownSync|symlink|symlinkSync|link|linkSync|truncate|truncateSync|cp|cpSync)\s*\(/,
	/\.(?:rm|rmdir|unlink|rename|chmod|chown|symlink|link|truncate|cp)(?:Sync)?\b/,
	/\bprocess\s*\.\s*(?:binding|dlopen|kill|chdir|abort)\b/,
	/\bprocess\s*\.\s*env\s*(?:\.\w+|\[[^\]]*\])?\s*=[^=]/,
	/["'`/]\.(?:env|ssh|aws|npmrc|netrc)\b|id_rsa|credentials|keychain/,
	/["'`]\/(?:etc|usr|var|bin|sbin|Library|System|Users|home|root|opt|Volumes)\b/,
	/["'`]\/private\/(?!tmp\/)/,
	/\bos\s*\.\s*(?:homedir|userInfo)\b|\bhomedir\s*\(/,
];

export type RunInProject = { ok: true; reason: string } | { ok: false };
const NO: RunInProject = { ok: false };

function lstatOrNull(p: string): ReturnType<typeof lstatSync> | null {
	try {
		return lstatSync(p);
	} catch {
		return null;
	}
}

function underTemp(p: string): boolean {
	return TEMP_ROOTS.some((r) => p === r || p.startsWith(`${r}/`));
}

/**
 * A path-like token that stays in the workspace or under /tmp: no `..`, no
 * secret name, and, when it exists, not a symlink. `root` is the real workspace.
 */
function pathOk(token: string, root: string): boolean {
	if (SECRET.test(token)) return false;
	if (token.split("/").some((s) => s === "..")) return false;
	const abs = path.isAbsolute(token) ? path.normalize(token) : path.resolve(root, token);
	if (!(inside(abs, root) || underTemp(abs))) return false;
	const st = lstatOrNull(abs);
	if (st?.isSymbolicLink()) return false;
	return true;
}

/** Relative import specifiers in `src`, resolved against `dir`. Packages and node: builtins are not followed. */
function localImports(src: string, dir: string): string[] {
	const out: string[] = [];
	const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
	for (const m of src.matchAll(re)) {
		const spec = m[1];
		if (!spec.startsWith(".") && !spec.startsWith("/")) continue;
		out.push(path.resolve(dir, spec));
	}
	return out;
}

const TRY_EXT = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", "/index.ts", "/index.js"];

function resolveFile(base: string, root: string): string | null {
	for (const e of TRY_EXT) {
		const p = base + e;
		const st = lstatOrNull(p);
		if (st?.isFile() && !st.isSymbolicLink()) {
			const real = realpathSync(p);
			return inside(real, root) ? real : null;
		}
	}
	return null;
}

/** True when the script and its local imports show nothing on DANGEROUS. */
function sourceClean(entry: string, root: string): boolean {
	const seen = new Set<string>();
	const queue = [entry];
	let bytes = 0;
	while (queue.length) {
		const file = queue.pop() as string;
		if (seen.has(file)) continue;
		if (seen.size >= MAX_FILES) return false;
		seen.add(file);
		const rel = path.relative(root, file);
		if (hasDotSegment(rel) || protectedRel(rel) || SECRET.test(rel)) return false;
		const src = readFileSync(file, "utf8");
		bytes += src.length;
		if (bytes > MAX_BYTES) return false;
		if (DANGEROUS.some((re) => re.test(src))) return false;
		for (const base of localImports(src, path.dirname(file))) {
			if (!inside(path.normalize(base), root)) return false;
			const resolved = resolveFile(base, root);
			if (!resolved) return false;
			queue.push(resolved);
		}
	}
	return true;
}

/**
 * ok when `command` is `[NAME=value ...] bun|bun run|node <script> [args]` with
 * the script and its imports inside `cwd` and clean; see the header.
 */
export function runInProject(command: string, cwd: string | undefined): RunInProject {
	try {
		if (!cwd || !path.isAbsolute(cwd)) return NO;
		const text = command.trim();
		if (!PLAIN.test(text) || promptControlText(text) !== null) return NO;
		if (decideRules(text).rules.length !== 0) return NO;
		const root = realpathSync(cwd);
		const words = text.split(/ +/);
		let i = 0;
		let envCount = 0;
		while (i < words.length && !words[i].startsWith("-") && words[i].includes("=")) {
			const m = ENV_ASSIGN.exec(words[i]);
			if (!m || ENV_DENY.test(m[1]) || ++envCount > MAX_ENV) return NO;
			const v = m[2];
			if (SECRET.test(v)) return NO;
			if (v.includes("/") && !pathOk(v, root)) return NO;
			i++;
		}
		const bin = words[i++];
		if (bin !== "bun" && bin !== "node") return NO;
		if (bin === "bun" && words[i] === "run") i++;
		const scriptArg = words[i++];
		if (!scriptArg || scriptArg.startsWith("-") || !SCRIPT_EXT.test(scriptArg)) return NO;
		if (scriptArg.split("/").some((s) => s === "..") || SECRET.test(scriptArg)) return NO;
		const scriptAbs = path.isAbsolute(scriptArg) ? path.normalize(scriptArg) : path.resolve(root, scriptArg);
		const st = lstatOrNull(scriptAbs);
		if (!st || !st.isFile() || st.isSymbolicLink()) return NO;
		const realScript = realpathSync(scriptAbs);
		if (!inside(realScript, root)) return NO;

		for (const a of words.slice(i)) {
			if (a.startsWith("-")) {
				if (!/^--?[A-Za-z][A-Za-z0-9-]*(=[A-Za-z0-9._/+,@:-]*)?$/.test(a) || BAD_FLAG.test(a)) return NO;
			}
			const eq = a.indexOf("=");
			for (const tok of eq === -1 ? [a] : [a, a.slice(eq + 1)]) {
				if (SECRET.test(tok)) return NO;
				if (tok.includes("/") && !pathOk(tok, root)) return NO;
			}
		}
		if (!sourceClean(realScript, root)) return NO;
		return {
			ok: true,
			reason: `run of ${path.relative(root, realScript)}: a workspace script that spawns, fetches and deletes nothing`,
		};
	} catch {
		return NO;
	}
}
