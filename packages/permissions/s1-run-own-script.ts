/**
 * System One: running a shell script this session wrote in the workspace's .tmp (#4121).
 *
 * Pilot design-mockup-practice (main 00f7e8ae, run 2026-10-12_224020): the
 * layout check tool could not render the page, so the model wrote
 * `.tmp/serve.sh` with write_file and ran `bash .tmp/serve.sh`. The judge has
 * no filesystem to look at; it scored that plain command pYes 0.4913 and
 * blocked it, final. This module reads the script instead. Same design as
 * s1-rm-own-dir.ts (#4105): an ALLOWLIST of one exact shape. Anything else is
 * "no opinion" and goes to the judge as before. The gate calls this only in
 * System One's default mode, after every earlier layer allowed the command.
 *
 * After the 8SO hold on #4123: bash and sh only (no python3, no bun), and the
 * script is read with an allowlist, not a deny-list.
 *
 * `runOwnScript` answers ok only when ALL hold:
 *   - POSIX (never on win32), an absolute working directory, a session record;
 *   - the command is exactly `bash .tmp/FILE` or `sh .tmp/FILE`, one space,
 *     no leading or trailing whitespace: no flag, `--`, env prefix, quote,
 *     glob, `$`, redirect, pipe, `;`, `&`, newline or second argument; FILE
 *     ends in .sh or has no extension; decideRules fires nothing, no
 *     prompt-control text;
 *   - the path has no `.`, `..` or empty segment; no component from the
 *     workspace root down to it is a symlink; its real path is inside the
 *     workspace's real .tmp;
 *   - the file is a regular file with nlink 1, owned by this process's user,
 *     born no earlier than this process started (and the file system reports
 *     a birth time), and the session's record (s1-created-files.ts) says this
 *     session created it and it is still that file (device, inode, change and
 *     birth time, size): a pre-existing, renamed-in, hard-linked or rewritten
 *     file fails;
 *   - its text passes `scriptProblem`: at most 64 KB, made only of
 *     [A-Za-z0-9 ._/:=,@+%-], tabs, newlines and the operators `; & | < > #`
 *     (so no quote, `$`, backtick, backslash, paren, brace, glob, `~`, `!` or
 *     non-ASCII), no here-doc, decideRules fires nothing on any line; every
 *     command (each part between `; & |`, an `exec ` prefix allowed) is one
 *     of SAFE_COMMANDS, or exactly `python3 -I -m http.server PORT --bind
 *     127.0.0.1` (the only listener, loopback only; -I keeps the served
 *     directory off sys.path, so a local `http/` package cannot shadow the
 *     server, 8SO on #4123); `cd` takes one argument; and every argument
 *     and redirect target stays inside the workspace by spelling and by
 *     real path (no `..`, no absolute path outside it, no symlink out) from
 *     EVERY directory the shell could be in, names no dot entry but a
 *     leading .tmp and no secret or protected path, and every `>` / `>>`
 *     target lands under .tmp (8TO on #4123: a script may not write
 *     .git/config, .8gent or project source, nor read .env, that the same
 *     line run directly would take to the judge). A `cd` may fail (a missing
 *     directory) or run in a subshell (`a | cd b`), so each cd adds its
 *     target to the set of possible directories and never drops one (8SO on
 *     #4123). A flag word may not carry a path.
 *
 * When the command has the right shape but the script fails, the result
 * carries a hint for the block message saying what would pass.
 *
 * Known limits, on purpose: TOCTOU between this check and the spawn, as for
 * the sibling lanes. A long-running server still runs in the foreground of
 * run_command. The server does no Host-header check, so a browser page using
 * DNS rebinding could read what it serves over loopback (8SO note on #4123);
 * a follow-up candidate is refusing to serve the workspace root.
 *
 * Linux and macOS only: on win32 the lane refuses (its file checks, birth
 * time and nlink are POSIX-shaped), and says so in the block message.
 *
 * Synchronous, never throws.
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { promptControlText } from "../decide/guard";
import { decideRules } from "../decide/rules";
import type { CreatedFiles } from "./s1-created-files";
import { protectedRel } from "./s1-mv-in-project";
import { inside } from "./s1-rm-nothing";
import { SECRET } from "./s1-run-in-project";

export type RunOwnScript = { ok: true; reason: string } | { ok: false; hint?: string };

const COMMAND = /^(bash|sh) (\.tmp\/[A-Za-z0-9._/+,=@:-]+)$/;
const SHELL_FILE = /(^|\/)[^./]+(\.sh)?$/;
const SHEBANG = /^#!(\/bin\/(ba)?sh|\/usr\/bin\/env (ba)?sh)[ \t]*$/;
const SCRIPT_CHARS = /^[A-Za-z0-9 \t\n._/:=,@+%#;&|<>-]*$/;
/** Commands a script may run. Nothing here runs another program or reaches the network. */
const SAFE_COMMANDS = new Set(["cd", "echo", "ls", "cat", "mkdir", "pwd", "sleep", "true"]);
/** The one listener: python's static server on loopback. */
const LOOPBACK_SERVER = /^python3 -I -m http\.server \d{1,5} (--bind|-b) 127\.0\.0\.1$/;
/** At most this many possible working directories are tracked; more is refused. */
const MAX_DIRS = 32;
const MAX_BYTES = 64 * 1024;
const NO: RunOwnScript = { ok: false };
/** When this process started, in ns, less a second for coarse clocks. */
const SINCE_NS = BigInt(Math.floor(performance.timeOrigin) - 1000) * 1_000_000n;

const WHAT_PASSES =
	"A script runs without review only as `bash .tmp/FILE` (or `sh`) with no other words, where FILE is one this session wrote with write_file and holds only literal lines of cd, echo, ls, cat, mkdir, pwd, sleep, true, or `python3 -I -m http.server PORT --bind 127.0.0.1`, with every path inside the workspace and outside dot directories, writing only under .tmp: no quotes, `$`, backticks, `..` or here-docs.";

const WIN32_HINT =
	"Running a session script without review works on Linux and macOS only; on Windows it goes to the checker.";

function hint(why: string): RunOwnScript {
	return { ok: false, hint: `${why} ${WHAT_PASSES}` };
}

/**
 * The workspace-relative forms of `p` resolved from `dir`: as spelled (from
 * `cwd` or its real path `root`) and by real path (the nearest existing
 * ancestor resolved, the rest appended). Null when either is outside the
 * workspace or `p` has a `..` segment.
 */
function workspaceRels(p: string, dir: string, cwd: string, root: string): string[] | null {
	if (p.split("/").includes("..")) return null;
	const abs = path.resolve(dir, p);
	if (!inside(abs, root) && !inside(abs, cwd)) return null;
	const spelled = path.relative(inside(abs, root) ? root : cwd, abs);
	let probe = abs;
	let tail = "";
	for (;;) {
		try {
			const real = path.join(realpathSync(probe), tail);
			return inside(real, root) ? [spelled, path.relative(root, real)] : null;
		} catch {
			const up = path.dirname(probe);
			if (up === probe) return null;
			tail = path.join(path.basename(probe), tail);
			probe = up;
		}
	}
}

/**
 * Null when the script may name `p` from `dir`, else why not (8TO on #4123).
 * Inside the workspace by spelling and real path; no dot entry on either
 * form except a leading `.tmp` (so .git, .8gent, .ssh, .env, .aws, .kube and
 * .gnupg are never touched); no secret or protected path. A write (`>`,
 * `>>`) must land under `.tmp`: `cat .tmp/x >> .git/config` or
 * `cat .tmp/x > src/app.ts` run directly would go to the judge, so a script
 * may not do them without it.
 */
function pathProblem(
	p: string,
	dir: string,
	cwd: string,
	root: string,
	write: boolean,
): string | null {
	const rels = workspaceRels(p, dir, cwd, root);
	if (!rels) return `it names \`${p}\`, which is outside the workspace`;
	for (const rel of rels) {
		const segs = rel === "" ? [] : rel.split(path.sep);
		if (segs.some((seg, i) => seg.startsWith(".") && !(i === 0 && seg === ".tmp")))
			return `it names \`${p}\`, a dot file or a path in a dot directory other than .tmp`;
		if (SECRET.test(rel) || protectedRel(rel))
			return `it names \`${p}\`, a secret or protected path`;
		if (write && (segs[0] !== ".tmp" || segs.length < 2))
			return `it writes \`${p}\`, which is not under the workspace's .tmp`;
	}
	return null;
}

/** Null when the script text is acceptable (see the header), else why not. */
export function scriptProblem(src: string, cwd: string, root: string): string | null {
	if (src.length > MAX_BYTES) return "it is larger than 64 KB";
	if (src.startsWith("#!")) {
		const nl = src.indexOf("\n");
		const first = nl < 0 ? src : src.slice(0, nl);
		if (!SHEBANG.test(first)) return "its #! line names something other than sh or bash";
		src = nl < 0 ? "" : src.slice(nl + 1);
	}
	if (!SCRIPT_CHARS.test(src))
		return "it uses a character outside plain words (a quote, `$`, backtick, backslash, paren, brace, glob, `~` or non-ASCII)";
	if (promptControlText(src) !== null) return "it carries prompt-control text";
	if (/<<|<>|>\|/.test(src)) return "it uses a here-doc or an unusual redirect";
	// Every directory the shell could be in at this point (see the header).
	const dirs = new Set([cwd]);
	for (const raw of src.split("\n")) {
		const line = raw.replace(/(^|[ \t])#.*$/, "").trim();
		if (line === "") continue;
		const fired = decideRules(line).rules;
		if (fired.length > 0) return `its line \`${line}\` fires rule ${fired.join(", ")}`;
		for (const part of line.split(/[;&|]+/)) {
			const words = part
				.trim()
				.split(/[ \t]+/)
				.filter(Boolean);
			if (words[0] === "exec") words.shift();
			if (words.length === 0) continue;
			if (LOOPBACK_SERVER.test(words.join(" "))) continue;
			const cmd = words[0] as string;
			if (cmd.startsWith("python3") && words.includes("http.server"))
				return "`python3 -m http.server` must be exactly `python3 -I -m http.server PORT --bind 127.0.0.1`: without -I a local `http` package in the served directory runs instead, and anything else binds every interface or does more";
			if (!SAFE_COMMANDS.has(cmd)) return `it runs \`${cmd}\`, which is not on the list`;
			const args = words.slice(1);
			const targets: string[] = [];
			const writes: string[] = [];
			for (let i = 0; i < args.length; i++) {
				const a = args[i] as string;
				// `2>&1` never gets here: `&` splits it, and the parts fail.
				const bare = /^\d?(>>?|<)$/.exec(a);
				if (bare) {
					const t = args[++i];
					if (!t) return "it has a redirect with no target";
					(bare[1] === "<" ? targets : writes).push(t);
					continue;
				}
				const glued = /^\d?(>>?|<)(.+)$/.exec(a);
				if (glued) {
					(glued[1] === "<" ? targets : writes).push(glued[2] as string);
					continue;
				}
				if (a.startsWith("-")) {
					if (a.includes("/")) return `the flag \`${a}\` carries a path`;
					continue;
				}
				targets.push(a);
			}
			for (const [list, write] of [
				[targets, false],
				[writes, true],
			] as const)
				for (const t of list)
					for (const dir of dirs) {
						const why = pathProblem(t, dir, cwd, root, write);
						if (why) return why;
					}
			if (cmd === "cd") {
				if (targets.length !== 1 || args.length !== 1 || writes.length > 0)
					return "`cd` must take exactly one path";
				for (const dir of [...dirs]) dirs.add(path.resolve(dir, targets[0] as string));
				if (dirs.size > MAX_DIRS) return "it changes directory too many ways to follow";
			}
		}
	}
	return null;
}

/**
 * ok when `command` runs, with no other words, a shell script this session
 * wrote under the workspace's .tmp whose text is on the allowlist; see the
 * header.
 */
export function runOwnScript(
	command: string,
	cwd: string | undefined,
	created: CreatedFiles | undefined,
): RunOwnScript {
	try {
		if (process.platform === "win32")
			return COMMAND.test(command) ? { ok: false, hint: WIN32_HINT } : NO;
		if (!cwd || !path.isAbsolute(cwd) || !created) return NO;
		const m = COMMAND.exec(command);
		if (!m) return NO;
		const [, interp, rel] = m as unknown as [string, string, string];
		if (promptControlText(command) !== null || decideRules(command).rules.length > 0) return NO;
		const segs = rel.split("/");
		if (segs.some((s) => s === "" || s === "." || s === "..")) return NO;
		if (!SHELL_FILE.test(rel)) return hint(`\`${rel}\` is not a shell script name.`);
		const root = realpathSync(cwd);
		let cur = root;
		for (const s of segs) {
			cur = path.join(cur, s);
			const st = lstatSync(cur, { throwIfNoEntry: false });
			if (!st) return NO;
			if (st.isSymbolicLink()) return hint(`\`${rel}\` has a symlink on its path.`);
		}
		const tmp = path.join(root, ".tmp");
		if (realpathSync(tmp) !== tmp || !inside(realpathSync(cur), tmp))
			return hint(`\`${rel}\` is not inside the workspace's .tmp.`);
		const st = lstatSync(cur, { bigint: true });
		if (!st.isFile()) return hint(`\`${rel}\` is not a regular file.`);
		if (st.nlink !== 1n) return hint(`\`${rel}\` has more than one hard link.`);
		if (typeof process.getuid !== "function" || st.uid !== BigInt(process.getuid()))
			return hint(`\`${rel}\` is not owned by this session's user.`);
		if (st.birthtimeNs <= 0n || st.birthtimeNs < SINCE_NS)
			return hint(`\`${rel}\` was not created during this session.`);
		if (!created.createdBySession(cur))
			return hint(`\`${rel}\` is not a file this session wrote (or it changed since).`);
		const why = scriptProblem(readFileSync(cur, "utf8"), cwd, root);
		if (why) return hint(`\`${rel}\`: ${why}.`);
		return {
			ok: true,
			reason: `${interp} of ${rel}, a script this session wrote: allowlisted literal commands, loopback only, workspace paths only`,
		};
	} catch {
		return NO;
	}
}
