/**
 * System One: judge the body of a script the model runs as `bash <file>` (#3877).
 *
 * Pilot msg-post-caption (11 Oct 2026): the model wrote its curl post into
 * .tmp/post.sh and ran `bash .tmp/post.sh`. System One saw only that command
 * line, scored it pYes 0.585 (escalate band; headless escalate is a block) and
 * refused. A script was also strictly less inspected than the same lines typed
 * inline: the rules and the judge never opened the file.
 *
 * `resolveScriptRun` recognises exactly `bash|sh|zsh|dash [-eux...] <path>` and
 * returns the file's text, so the gate can judge the body exactly as if those
 * lines had been the command. It can only add scrutiny, never remove it.
 *
 *   none    not that shape (`-c`, `-s`, pipes, redirects, other commands): the
 *           gate behaves as before.
 *   refuse  that shape, but the file cannot be judged: fail closed. Missing,
 *           unreadable, a symlink, not a regular file, outside the workspace,
 *           larger than 4096 bytes, contains NUL, a path or argument with
 *           quotes or expansions. Plain-word arguments are allowed and are
 *           shown to the judge as `set -- <args>` above the body.
 *   ok      the text to judge, a sha256, and what is needed to run a private
 *           copy of the judged bytes (`stageScript`).
 *
 * Arguments (F1): positional parameters are substituted into the judged text
 * ($1..$9, ${N}, $@, $*), so the rules and the judge see the real path exactly
 * as they would inline. An argument with "/" or a leading "." must resolve
 * inside the workspace. Bodies that use shift, getopts, $#, ${!x}, `set --`,
 * a ${1:-default} form, or refer to their own file ($0, BASH_SOURCE) are
 * refused, because their meaning cannot be read off the text.
 *
 * Self-modification (F2, F4): the shell is not given the path that was judged.
 * `stageScript` writes the judged bytes to a private 0700 directory (file
 * 0400) and the command runs that copy, so lines appended to the original
 * after the check, or by the script to itself, never run.
 *
 * Residual, documented and not a regression (same as typed lines): a judged
 * body can still reach code nobody judged through `source`, `.`, `exec`, a
 * second file it writes and then runs, or `eval "$(cat f)"`. Only a body that
 * is exactly one `bash <file>` line is followed. Scripts that locate siblings
 * through $0 are refused, so they use plain relative paths from the working
 * directory.
 * Synchronous, never throws.
 */

import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

export const MAX_SCRIPT_BYTES = 4096;

const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const SAFE_PATH = /^[A-Za-z0-9._/+,=@:-]+$/;
/** Option letters that only change shell behaviour; `-c` and `-s` are excluded on purpose. */
const SAFE_FLAG = /^-[eux]+$/;

export interface ScriptRef {
	abs: string;
	rel: string;
	sha256: string;
}

export type ScriptRun =
	| { kind: "none" }
	| { kind: "refuse"; reason: string }
	| { kind: "ok"; body: string; script: ScriptRef; run: ScriptInvocation };

/** What `stageScript` needs to rebuild the command around a private copy. */
export interface ScriptInvocation {
	shell: string;
	flags: string[];
	args: string[];
	bytes: Buffer;
	name: string;
}

function insideDir(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function readJudgeable(
	abs: string,
	root: string,
): { text: string; sha256: string; bytes: Buffer } | string {
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(abs);
	} catch {
		return "the script file does not exist or cannot be read";
	}
	if (st.isSymbolicLink()) return "the script is a symlink";
	if (!st.isFile()) return "the script is not a regular file";
	if (st.size > MAX_SCRIPT_BYTES)
		return `the script is ${st.size} bytes, over the ${MAX_SCRIPT_BYTES} byte limit for judging`;
	let real: string;
	try {
		real = realpathSync(abs);
	} catch {
		return "the script path cannot be resolved";
	}
	if (!insideDir(root, real)) return "the script is outside the workspace";
	let buf: Buffer;
	try {
		buf = readFileSync(abs);
	} catch {
		return "the script file cannot be read";
	}
	if (buf.length > MAX_SCRIPT_BYTES) return "the script grew past the size limit while reading";
	if (buf.includes(0)) return "the script contains a NUL byte (binary)";
	return {
		text: buf.toString("utf8"),
		sha256: createHash("sha256").update(buf).digest("hex"),
		bytes: buf,
	};
}

const SELF_REF = /\$\{?0(?![0-9])|BASH_SOURCE|\$\{?BASH\b/;
const UNREADABLE_PARAMS = /\bshift\b|\bgetopts\b|\$#|\$\{#|\$\{!|\bset\s+--/;
const PARAM_DEFAULT = /\$\{[0-9@*][^}0-9@*]|\$\{[0-9]{2,}/;

/** Put the real argument values where $1..$9, ${N}, $@ and $* stand, so the judge reads what will run. */
export function substituteArgs(text: string, args: string[]): string {
	return text
		.replace(/\$\{([@*])\}|\$([@*])/g, () => args.join(" "))
		.replace(
			/\$\{([1-9])\}|\$([1-9])/g,
			(_m, a: string | undefined, b: string | undefined) => args[Number(a ?? b) - 1] ?? "",
		);
}

/**
 * Write the judged bytes to a private directory (0700, file 0400) and return
 * the command that runs that copy, plus a cleanup. Never throws; null means the
 * copy could not be made and the caller must fail closed.
 */
export function stageScript(
	run: ScriptInvocation,
): { command: string; cleanup: () => void } | null {
	try {
		if (!swept) {
			swept = true;
			sweepStaleScriptCopies();
		}
		const dir = mkdtempSync(path.join(tmpdir(), STAGE_PREFIX));
		chmodSync(dir, 0o700);
		const file = path.join(dir, run.name);
		writeFileSync(file, run.bytes, { mode: 0o400 });
		const cleanup = () => {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// best effort
			}
		};
		staged.add(cleanup);
		const command = [run.shell, ...run.flags, `'${file}'`, ...run.args].join(" ");
		return {
			command,
			cleanup: () => {
				staged.delete(cleanup);
				cleanup();
			},
		};
	} catch {
		return null;
	}
}

const staged = new Set<() => void>();

export const STAGE_PREFIX = "s1-script-";
/** A private copy older than this is a leftover of a crash or SIGKILL, not a live background task. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
let swept = false;

/**
 * Remove private copies left behind by a crash or SIGKILL: only entries of the
 * temp root named `s1-script-*`, real directories (lstat, symlinks are never
 * followed or removed), owned by this user, untouched for STALE_AFTER_MS.
 * Returns how many were removed. Never throws.
 */
export function sweepStaleScriptCopies(
	root: string = tmpdir(),
	maxAgeMs: number = STALE_AFTER_MS,
	now: number = Date.now(),
): number {
	let removed = 0;
	try {
		const uid = process.getuid?.();
		for (const name of readdirSync(root)) {
			if (!name.startsWith(STAGE_PREFIX)) continue;
			try {
				const full = path.join(root, name);
				const st = lstatSync(full);
				if (st.isSymbolicLink() || !st.isDirectory()) continue;
				if (uid !== undefined && st.uid !== uid) continue;
				if (now - st.mtimeMs < maxAgeMs) continue;
				rmSync(full, { recursive: true, force: true });
				removed++;
			} catch {
				// leave it
			}
		}
	} catch {
		// unreadable temp root: nothing to sweep
	}
	return removed;
}
process.on("exit", () => {
	for (const c of staged) c();
});

export function resolveScriptRun(command: string, cwd?: string): ScriptRun {
	try {
		const line = command.trim();
		if (/[\n\r|;&<>`$()]/.test(line)) return { kind: "none" };
		const words = line.split(/\s+/);
		if (words.length < 2 || !SHELLS.has(words[0])) return { kind: "none" };
		let i = 1;
		while (i < words.length && words[i].startsWith("-")) {
			if (!SAFE_FLAG.test(words[i])) return { kind: "none" }; // -c, -s, --, -l ...: rules handle it
			i++;
		}
		if (i >= words.length) return { kind: "none" };
		const file = words[i];
		const args = words.slice(i + 1);
		if (args.some((a) => !SAFE_PATH.test(a)))
			return {
				kind: "refuse",
				reason: "an argument has quotes, spaces or expansions, so the script cannot be checked",
			};
		if (!SAFE_PATH.test(file))
			return {
				kind: "refuse",
				reason: "the script path has quotes or expansions, so it cannot be judged",
			};
		let root: string;
		try {
			root = realpathSync(path.resolve(cwd ?? process.cwd()));
		} catch {
			return { kind: "refuse", reason: "the working directory cannot be resolved" };
		}
		for (const a of args) {
			if (!a.includes("/") && !a.startsWith(".")) continue;
			let target = path.resolve(root, a);
			try {
				target = realpathSync(target);
			} catch {
				// not there yet: judge the lexical path
			}
			if (target !== root && !insideDir(root, target))
				return { kind: "refuse", reason: "an argument points outside the workspace" };
		}
		const abs = path.resolve(root, file);
		const r = readJudgeable(abs, root);
		if (typeof r === "string") return { kind: "refuse", reason: r };
		const text = r.text;
		if (SELF_REF.test(text))
			return {
				kind: "refuse",
				reason: "the script refers to its own file ($0 or BASH_SOURCE), so it cannot be checked",
			};
		if (args.length > 0 && UNREADABLE_PARAMS.test(text))
			return {
				kind: "refuse",
				reason: "the script shifts or reshapes its arguments, so it cannot be checked",
			};
		if (PARAM_DEFAULT.test(text))
			return {
				kind: "refuse",
				reason: "the script uses a parameter default form, so it cannot be checked",
			};
		return {
			kind: "ok",
			// The judge sees the real values, as they would be typed inline.
			body: substituteArgs(text, args),
			run: {
				shell: words[0],
				flags: words.slice(1, i),
				args,
				bytes: r.bytes,
				name: path.basename(abs),
			},
			script: { abs, rel: path.relative(root, abs), sha256: r.sha256 },
		};
	} catch (err) {
		return {
			kind: "refuse",
			reason: `the script could not be checked (${(err as Error)?.message ?? err})`,
		};
	}
}

/** Right before spawn: null when every judged file still has its judged bytes, else a tool-error text. */
export function scriptChanged(scripts: ScriptRef[] | undefined): string | null {
	for (const script of scripts ?? []) {
		let buf: Buffer;
		try {
			buf = readFileSync(script.abs);
		} catch {
			return `[SYSTEM ONE BLOCKED] The script ${script.rel} changed or vanished after it was checked. The command was not run.`;
		}
		if (createHash("sha256").update(buf).digest("hex") !== script.sha256)
			return `[SYSTEM ONE BLOCKED] The script ${script.rel} changed after it was checked. The command was not run. Write the script again and run it once.`;
	}
	return null;
}

const CONTROL_WORDS = new Set([
	"eval",
	"source",
	".",
	"function",
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"for",
	"while",
	"until",
	"do",
	"done",
	"case",
	"esac",
	"select",
	"{",
	"}",
	"!",
	"exec",
	"trap",
	"alias",
	"bash",
	"sh",
	"zsh",
	"dash",
	"ksh",
	"command",
	"builtin",
	"cd",
	"pushd",
	"popd",
	"chdir",
	"export",
	"unset",
	"umask",
	"shopt",
	"setopt",
	"set",
	"hash",
	"ulimit",
	"read",
	"local",
	"declare",
	"typeset",
	"readonly",
	"wait",
	"exit",
	"return",
	"env",
	"nice",
	"time",
	"xargs",
	"nohup",
	"timeout",
	"sudo",
]);

/** True when the line, outside quotes, holds nothing but plain words (no operators, substitution or expansion tricks). */
function plainLine(line: string): boolean {
	let i = 0;
	while (i < line.length) {
		const c = line[i];
		if (c === "'") {
			const j = line.indexOf("'", i + 1);
			if (j < 0) return false;
			i = j + 1;
			continue;
		}
		if (c === '"') {
			i++;
			while (i < line.length && line[i] !== '"') {
				if (line[i] === "\\" || line[i] === "`") return false;
				if (line[i] === "$" && line[i + 1] === "(") return false;
				i++;
			}
			if (i >= line.length) return false;
			i++;
			continue;
		}
		if (/[;&|<>(){}`\\]/.test(c)) return false;
		if (c === "$" && line[i + 1] === "(") return false;
		i++;
	}
	return true;
}

/**
 * Split a judged script body into its simple commands, one per line, for the
 * deterministic lanes (#3877). Returns null (send the whole body to the judge)
 * when the body holds anything a line-by-line reading cannot cover: functions,
 * eval, source or `.`, `$(...)`, backticks, pipes or other operators, here-docs,
 * redirects, control flow, backslash continuations, a nested shell. Blank
 * lines, comments, a `#!` line and `set -e|-u|-x` are skipped.
 */
export function splitSimpleCommands(body: string): string[] | null {
	if (/<<|`|\$\(/.test(body)) return null;
	const out: string[] = [];
	for (const raw of body.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		if (/^set\s+-[eux]+$/.test(line)) continue;
		if (!plainLine(line)) return null;
		const first = line.split(/\s+/)[0];
		// A quoted or escaped command name (`'cd'`, `c""d`) would dodge the word list.
		if (/['"\\$`]/.test(first)) return null;
		if (
			CONTROL_WORDS.has(first.toLowerCase()) ||
			/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) ||
			/\(\)/.test(line)
		)
			return null;
		out.push(line);
	}
	return out.length > 0 ? out : null;
}

/** Words of a plain line that can name a path: no command name, no flags, quotes and a leading ./ removed. */
function pathWords(line: string): string[] {
	return line
		.split(/\s+/)
		.slice(1)
		.filter((w) => w !== "" && !w.startsWith("-"))
		.map((w) =>
			w
				.replace(/^['"]|['"]$/g, "")
				.replace(/^(\.\/)+/, "")
				.replace(/\/+$/, ""),
		);
}

/** A path as the filesystem compares it: case-insensitive (macOS default), `//` collapsed. Fail closed. */
function normPath(w: string): string {
	return w
		.replace(/\/+/g, "/")
		.replace(/^(\.\/)+/, "")
		.toLowerCase();
}

/**
 * Every final path a line could touch: each word, plus for every pair of words the second dropped into
 * the first as a directory (`mv a sub/` writes `sub/a`, `mv -t sub a` too). Over-approximates on purpose.
 */
function reachedPaths(words: string[]): Set<string> {
	const out = new Set<string>();
	for (const w of words) out.add(normPath(w));
	for (let i = 0; i < words.length; i++) {
		for (let j = 0; j < words.length; j++) {
			if (i === j) continue;
			const base = words[j].split("/").pop() ?? "";
			if (base !== "") out.add(normPath(`${words[i]}/${base}`));
		}
	}
	return out;
}

/**
 * True when a later line names a path that an earlier line names (#3878, 8SO). The lanes judge each
 * line against the files as they stand before the script runs, so `mv a keep` then `mv b keep` passes
 * line by line yet the second overwrites what the first created. Fail closed: a script where any word
 * that could be a path repeats across lines is not allowed on the lanes alone and goes to the judge.
 * Paths compare case-insensitively (`KEEP.txt` is `keep.txt` on a default Mac volume), and a move or
 * copy into a directory is resolved to dir/basename first (`mv a sub/` then `mv b sub/a`).
 */
export function laterLineReusesEarlierPath(cmds: string[]): boolean {
	const seen = new Set<string>();
	for (const c of cmds) {
		const reached = reachedPaths(pathWords(c));
		for (const w of reached) if (seen.has(w)) return true;
		for (const w of reached) seen.add(w);
	}
	return false;
}
