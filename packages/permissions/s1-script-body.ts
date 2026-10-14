/**
 * System One: check a script file by what it holds, not by its name.
 *
 * `bash FILE`, `sh FILE` (also zsh, dash, ksh), `. FILE`, `source FILE` and `./FILE` (any path
 * word naming a shell script) run text the command does not show. The rules, the prompt-control
 * check and the judge read only the command, so without this the verdict would rest on the file
 * name. `scriptLaunch` finds such a launch and reads a bounded copy of the file once, so the gate
 * checks the body with the command (it can only raise the risk) and runs exactly the bytes it
 * checked, as the tg-send lane does (s1-tg-send.ts, #4102).
 *
 *   none      - the command launches no script file: the gate is unchanged.
 *   checked   - one launch, read. `body` is checked with the command. `runInstead` is the text the
 *               caller runs in place of the command: the same shell, options, arguments and
 *               redirects around the checked bytes (`bash -c '<body>' FILE ARGS ...`; for `. FILE`
 *               the body itself). It is null when the command's shape cannot be rebuilt around
 *               the bytes (a wrapper, an assignment or quotes before the file, a launch after a
 *               pipe); the gate then asks a person instead of allowing.
 *   unchecked - a launch whose file cannot be read safely: over SCRIPT_BODY_CAP, missing, not a
 *               regular file, a symlink or under one, hardlinked (nlink > 1), outside the
 *               workspace, a secret-looking name, a path with an expansion, characters outside
 *               printable ASCII, a body that launches another script, more than one launch, or a
 *               shell reading its script from a pipe or a `<` file. The gate asks a person
 *               (headless: block). There is no "judge the bare command" fallback: padding a
 *               script past the cap must not bring back a verdict by name.
 *
 * Out of scope, follow-up: interpreter files (python, node, bun, ...), make and package scripts,
 * and non-POSIX shells (PowerShell, cmd), where the command is still judged as written.
 *
 * Synchronous. Never throws: an internal error is "unchecked".
 */

import { constants, closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import * as path from "node:path";
import { simpleCommands } from "../decide/rules";
import { inside } from "./s1-rm-nothing";
import { SECRET, canon, symlinkBelow } from "./s1-run-in-project";

/** The most of a script that is read and checked: 16 KiB. Larger goes to a person. */
export const SCRIPT_BODY_CAP = 16 * 1024;

export type ScriptLaunch =
	| { kind: "none" }
	| { kind: "checked"; rel: string; body: string; runInstead: string | null }
	| { kind: "unchecked"; why: string };

const NONE: ScriptLaunch = { kind: "none" };
const unchecked = (why: string): ScriptLaunch => ({ kind: "unchecked", why });

const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** A word whose text is its value: no quote, escape, expansion or glob. */
const PLAIN_WORD = /^[A-Za-z0-9._/+@%,:=-]+$/;
const SHORT_OPTS = /^[-+][A-Za-z]+$/;
const SAFE_LONG = new Set(["--posix", "--norc", "--noprofile", "--noediting"]);
const BINARY_MAGIC = [
	[0x7f, 0x45, 0x4c, 0x46],
	[0xcf, 0xfa, 0xed, 0xfe],
	[0xce, 0xfa, 0xed, 0xfe],
	[0xfe, 0xed, 0xfa, 0xcf],
	[0xfe, 0xed, 0xfa, 0xce],
	[0xca, 0xfe, 0xba, 0xbe],
];

type Launch =
	| { form: "shell"; argv0: string; opts: string[]; file: string }
	| { form: "source"; file: string; args: number }
	| { form: "exec"; file: string }
	| { form: "stdin" }
	| { form: "odd"; why: string };

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** The script launch in one simple command, or null when it runs no script file. */
function launchOf(argv: string[], stdin: boolean): Launch | null {
	if (!argv.length) return null;
	const w0 = argv[0];
	if (SHELL_NAMES.has(base(w0))) {
		const opts: string[] = [];
		let i = 1;
		for (; i < argv.length; i++) {
			const a = argv[i];
			if (a === "-") return { form: "stdin" };
			if (a === "--") return { form: "odd", why: "the shell is given `--` before the script" };
			if (SHORT_OPTS.test(a)) {
				// -c: the text to run is in the command, where the rules read it.
				if (a.slice(1).includes("c")) return null;
				// -s: the script comes from stdin.
				if (a.slice(1).includes("s")) return stdin ? { form: "stdin" } : null;
				opts.push(a);
				if (/^[-+][oO]$/.test(a)) {
					if (i + 1 >= argv.length) return null;
					opts.push(argv[++i]);
				}
				continue;
			}
			if (a.startsWith("--")) {
				if (SAFE_LONG.has(a)) {
					opts.push(a);
					continue;
				}
				return { form: "odd", why: `the shell option ${a} cannot be checked` };
			}
			break;
		}
		if (i >= argv.length) return stdin ? { form: "stdin" } : null;
		return { form: "shell", argv0: w0, opts, file: argv[i] };
	}
	if (w0 === "." || w0 === "source") {
		return argv.length > 1 ? { form: "source", file: argv[1], args: argv.length - 2 } : null;
	}
	if (w0.includes("/")) return { form: "exec", file: w0 };
	return null;
}

/** The shell a `#!` line names (`/bin/bash`, `/usr/bin/env bash`, one option at most), "" for none, null otherwise. */
function shebangShell(head: string): string | null {
	if (!head.startsWith("#!")) return "";
	const nl = head.indexOf("\n");
	const words = head
		.slice(2, nl === -1 ? undefined : nl)
		.trim()
		.split(/[ \t]+/);
	if (!words[0] || !path.isAbsolute(words[0]) || !words.every((w) => PLAIN_WORD.test(w)))
		return null;
	if (SHELL_NAMES.has(base(words[0]))) {
		if (words.length > 2) return null;
		if (words.length === 2 && (!SHORT_OPTS.test(words[1]) || /[cs]/.test(words[1].slice(1))))
			return null;
		return words.join(" ");
	}
	if (base(words[0]) === "env" && words.length === 2 && SHELL_NAMES.has(words[1]))
		return words.join(" ");
	return null;
}

/**
 * True when the file runs as a shell script: no `#!` line (the shell runs it as sh), or one whose
 * interpreter is a shell, directly or through env, with any options. An interpreter file (python,
 * node, ...) is not: out of scope here. Whether the line can be rebuilt is `shebangShell`'s
 * question; a shell script it cannot rebuild still counts, and goes to a person.
 */
function shebangNamesShell(head: string): boolean {
	if (!head.startsWith("#!")) return true;
	const nl = head.indexOf("\n");
	const words = head
		.slice(2, nl === -1 ? undefined : nl)
		.trim()
		.split(/[ \t]+/)
		.filter((w) => w !== "");
	if (!words.length) return true;
	if (base(words[0]) !== "env") return SHELL_NAMES.has(base(words[0]));
	const prog = words.slice(1).find((w) => !w.startsWith("-") && !w.includes("="));
	return prog === undefined || SHELL_NAMES.has(base(prog));
}

/**
 * What a path run directly is: "script" (a shell script, or a text file with no `#!`, which the
 * shell runs as sh), "other" (a binary, an interpreter file, a directory), or "unknown" (missing
 * or unreadable).
 */
function execKind(abs: string): "script" | "other" | "unknown" {
	try {
		const st = statSync(abs, { throwIfNoEntry: false });
		if (!st) return "unknown";
		if (!st.isFile()) return "other";
		const fd = openSync(abs, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
		try {
			const buf = Buffer.alloc(512);
			const n = readSync(fd, buf, 0, buf.length, 0);
			const head = buf.subarray(0, n);
			if (BINARY_MAGIC.some((m) => m.every((b, k) => head[k] === b))) return "other";
			if (head.includes(0)) return "other";
			return shebangNamesShell(head.toString("latin1")) ? "script" : "other";
		} finally {
			closeSync(fd);
		}
	} catch {
		return "unknown";
	}
}

type Read = { rel: string; body: string; mode: number } | { why: string };

/** Read the script once, by descriptor, with every condition in the header checked. */
function readScript(file: string, cwd: string | undefined, project: string | undefined): Read {
	if (!PLAIN_WORD.test(file))
		return {
			why: "the script path uses quoting, an expansion or a pattern the check cannot follow",
		};
	if (!cwd || !path.isAbsolute(cwd))
		return { why: "there is no working directory to find the script in" };
	const dir = canon(cwd);
	const root = project && path.isAbsolute(project) ? canon(project) : dir;
	const lexical = path.resolve(dir, file);
	if (!inside(lexical, root) || !inside(canon(lexical), root))
		return { why: "the script is outside the workspace" };
	const rel = path.relative(root, lexical);
	if (rel === "" || SECRET.test(rel) || /\.env$/i.test(base(rel)))
		return { why: "the script has the name of a secrets file, so it is not read" };
	if (symlinkBelow(root, lexical)) return { why: "the script path goes through a symlink" };
	let fd: number;
	try {
		fd = openSync(
			lexical,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
		);
	} catch {
		return { why: "the script cannot be opened (missing, unreadable or a symlink)" };
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) return { why: "the script is not a regular file" };
		// A hardlink to a file outside the workspace passes every path check above.
		if (st.nlink !== 1) return { why: "the script has more than one link" };
		if (st.size > SCRIPT_BODY_CAP)
			return { why: `the script is over ${SCRIPT_BODY_CAP / 1024} KiB` };
		const buf = Buffer.alloc(SCRIPT_BODY_CAP + 1);
		let n = 0;
		for (;;) {
			const got = readSync(fd, buf, n, buf.length - n, n);
			if (got === 0) break;
			n += got;
			if (n === buf.length) break;
		}
		if (n > SCRIPT_BODY_CAP) return { why: `the script is over ${SCRIPT_BODY_CAP / 1024} KiB` };
		const body = buf.subarray(0, n).toString("latin1");
		if (/[^\x20-\x7e\t\n]/.test(body))
			return { why: "the script holds characters other than printable ASCII, tab and newline" };
		return { rel: rel.split(path.sep).join("/"), body, mode: st.mode };
	} finally {
		closeSync(fd);
	}
}

/**
 * Programs that run their arguments as a command. The rules strip them when written by name; by
 * path (`/usr/bin/env bash FILE`), or as xargs and find -exec, the launch is found further in.
 */
const RUNS_ITS_ARGS = new Set([
	"env",
	"nohup",
	"time",
	"nice",
	"timeout",
	"gtimeout",
	"sudo",
	"doas",
	"stdbuf",
	"caffeinate",
	"arch",
	"xargs",
	"find",
	"command",
	"exec",
	"builtin",
	"unbuffer",
	"watch",
	"parallel",
]);

/** The script launch in one simple command (a path run directly counts only when it is a script), or null. */
function launchIn(
	argv: string[],
	stdin: boolean,
	cwd: string | undefined,
): { launch: Launch; direct: boolean } | null {
	const isScript = (l: Launch | null): l is Launch => {
		if (!l) return false;
		if (l.form !== "exec") return true;
		const abs = path.isAbsolute(l.file) ? l.file : cwd ? path.resolve(cwd, l.file) : null;
		return abs === null || execKind(abs) !== "other";
	};
	const l = launchOf(argv, stdin);
	if (isScript(l)) return { launch: l, direct: true };
	if (!argv.length || !RUNS_ITS_ARGS.has(base(argv[0]))) return null;
	// Further in, only a shell with a file, or a path that is a script on disk (`find .` is not `. FILE`).
	for (let j = 1; j < argv.length; j++) {
		const inner = launchOf(argv.slice(j), false);
		if (!inner || inner.form === "source" || inner.form === "stdin") continue;
		if (inner.form === "exec") {
			const abs = path.isAbsolute(inner.file)
				? inner.file
				: cwd
					? path.resolve(cwd, inner.file)
					: null;
			if (abs === null || execKind(abs) !== "script") continue;
		}
		return { launch: inner, direct: false };
	}
	return null;
}

/** True when `body` itself launches a script (or reads one from a pipe): one level only. */
function launchesScript(body: string, cwd: string): boolean {
	return simpleCommands(body).some((c) => launchIn(c.argv, c.stdin, cwd) !== null);
}

/** Leading plain `NAME=value` assignments, each followed by a space or tab. */
const ASSIGNMENTS = /^(?:[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9._/+@%,:=-]*[ \t]+)*/;
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The command with the checked bytes in place of the file, or null when its shape cannot be rebuilt. */
function rebuild(command: string, l: Launch, read: { body: string; mode: number }): string | null {
	const trimmed = command.trim();
	if (/[\r\n]/.test(trimmed)) return null;
	// Leading `NAME=value` words stay in front: they set the environment of the same shell.
	const pre = (ASSIGNMENTS.exec(trimmed) as RegExpExecArray)[0];
	const text = trimmed.slice(pre.length);
	const words = (ws: string[]) =>
		ws.every((w) => PLAIN_WORD.test(w)) ? ws.map(escapeRe).join("[ \\t]+") : null;
	if (l.form === "shell") {
		const head = words([l.argv0, ...l.opts, l.file]);
		const m = head === null ? null : new RegExp(`^${head}(?=$|[ \\t])`).exec(text);
		if (!m) return null;
		return `${pre}${[l.argv0, ...l.opts].join(" ")} -c ${quote(read.body)} ${l.file}${text.slice(m[0].length)}`;
	}
	if (l.form === "source") {
		// Sourced, the body runs in the command's own shell; assignments or arguments would not carry.
		const head = words([l.file]);
		if (pre !== "" || head === null || l.args !== 0) return null;
		if (!new RegExp(`^(\\.|source)[ \\t]+${head}$`).test(text)) return null;
		return read.body;
	}
	if (l.form === "exec") {
		const head = words([l.file]);
		const m = head === null ? null : new RegExp(`^${head}(?=$|[ \\t])`).exec(text);
		// Not executable: as written it would not run, so it is not run this way either.
		if (!m || (read.mode & 0o111) === 0) return null;
		const shell = shebangShell(read.body);
		if (shell === null) return null;
		return `${pre}${shell || "/bin/sh"} -c ${quote(read.body)} ${l.file}${text.slice(m[0].length)}`;
	}
	return null;
}

/** The script `command` launches, read and ready to check; see the header. */
export function scriptLaunch(
	command: string,
	cwd: string | undefined,
	project?: string,
): ScriptLaunch {
	try {
		const found: { launch: Launch; first: boolean }[] = [];
		simpleCommands(command).forEach((c, i) => {
			const hit = launchIn(c.argv, c.stdin, cwd);
			if (hit) found.push({ launch: hit.launch, first: i === 0 && hit.direct });
		});
		if (!found.length) return NONE;
		if (found.length > 1) return unchecked("the command runs more than one script");
		const { launch: l, first } = found[0];
		if (l.form === "stdin")
			return unchecked(
				"a shell reads its script from a pipe or a file redirect, so it cannot be read first",
			);
		if (l.form === "odd") return unchecked(l.why);
		const read = readScript(l.file, cwd, project);
		if ("why" in read) return unchecked(read.why);
		if (launchesScript(read.body, canon(cwd as string)))
			return unchecked("the script runs another script, which is not read");
		return {
			kind: "checked",
			rel: read.rel,
			body: read.body,
			runInstead: first ? rebuild(command, l, read) : null,
		};
	} catch {
		return unchecked("the script could not be checked");
	}
}
