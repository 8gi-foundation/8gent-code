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
 *               shell reading its script from a pipe or a `<` file. Also every launch shape that
 *               cannot be rebuilt into checked bytes: `-c` or `eval` text worked out when it runs
 *               (`"$(cat FILE)"`, a backtick, `"$S"`), a command name that is a substitution, a
 *               here-string or process substitution fed to a shell or a source, `env -S`,
 *               `sudo -s`/`-i`, a wrapper option not in its allowlist, xargs or find handing a
 *               shell the names they build, another program handing a shell a file, options or
 *               command text, and shells this file does not read (fish, csh, ...). Wrappers are
 *               read by an allowlist of the options each takes (`WRAPPERS`), so a shape not
 *               listed fails closed. The gate asks a person (headless: block). There is no
 *               "judge the bare command" fallback: padding a script past the cap must not bring
 *               back a verdict by name.
 *
 * The body is read up to 16 KiB, all of it by the rules; the judge is asked about it only when
 * the whole guard prompt fits the judge's window (`judgePromptFits` in decide/guard.ts, about
 * 3.4 KiB of script), and a longer body is at least escalate, never judged in part.
 *
 * Out of scope, follow-up: interpreter files (python, node, bun, ...), make and package scripts,
 * and non-POSIX shells (PowerShell, cmd), where the command is still judged as written.
 *
 * Synchronous. Never throws: an internal error is "unchecked".
 */

import { constants, closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import * as path from "node:path";
import { type SimpleCommand, simpleCommands } from "../decide/rules";
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
const odd = (why: string): Launch => ({ form: "odd", why });

/** Shells this check does not read: a launch through one is never rebuilt. */
const OTHER_SHELLS = new Set([
	"fish",
	"csh",
	"tcsh",
	"ash",
	"mksh",
	"yash",
	"pwsh",
	"powershell",
	"nu",
	"xonsh",
	"elvish",
	"busybox",
	"osh",
	"ysh",
]);
const isShell = (w: string) => SHELL_NAMES.has(base(w)) || OTHER_SHELLS.has(base(w));

/**
 * Programs that never run their arguments as a command: a shell name among their arguments is
 * text (`grep bash notes.md`, `which sh`), so the scan for a shell handed a file skips them.
 */
const INERT = new Set([
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"ack",
	"echo",
	"printf",
	"which",
	"type",
	"whereis",
	"man",
	"ls",
	"file",
	"stat",
	"cat",
	"head",
	"tail",
	"wc",
	"brew",
	"apt",
	"apt-get",
]);

/**
 * The options of a wrapper, read by an allowlist: letters in `flags` take no value, letters in
 * `valued` take one (attached, or the next word), `long` accepts whole words. Any other option
 * is one this check cannot follow, so the launch goes to a person. Returns the words after the
 * options.
 */
function skipOpts(
	w: string,
	t: string[],
	flags: string,
	valued: string,
	long: (a: string) => boolean = () => false,
): string[] | Launch {
	let i = 0;
	while (i < t.length && t[i].startsWith("-") && t[i] !== "-") {
		const a = t[i];
		if (a === "--") return t.slice(i + 1);
		if (long(a)) {
			i++;
			continue;
		}
		let take = 0;
		if (/^-[A-Za-z0-9]+$/.test(a)) {
			take = 1;
			for (let k = 1; k < a.length; k++) {
				if (flags.includes(a[k])) continue;
				if (valued.includes(a[k])) {
					take = k === a.length - 1 ? 2 : 1;
					break;
				}
				take = 0;
				break;
			}
		}
		if (take === 0) return odd(`the ${w} option ${a} is not one this check reads`);
		i += take;
	}
	return t.slice(i);
}

/** Leading `NAME=value` words (env's own assignments). */
function dropAssignments(t: string[]): string[] {
	let i = 0;
	while (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i])) i++;
	return t.slice(i);
}

/**
 * Wrappers that run the rest of their words as a command, each with the options it is known to
 * take. Words back: the command it runs. A Launch back: a shape that goes to a person (`env -S`,
 * `sudo -s`, an option not listed). null: it runs nothing (`command -v`, a bare `exec`).
 */
const WRAPPERS: Record<string, (t: string[]) => string[] | Launch | null> = {
	nohup: (t) => skipOpts("nohup", t, "", ""),
	time: (t) => skipOpts("time", t, "p", ""),
	noglob: (t) => t,
	"!": (t) => t,
	builtin: (t) => skipOpts("builtin", t, "", ""),
	unbuffer: (t) => skipOpts("unbuffer", t, "p", ""),
	caffeinate: (t) => skipOpts("caffeinate", t, "dimsu", "tw"),
	arch: (t) =>
		skipOpts("arch", t, "", "", (a) => /^-(?:x86_64h?|arm64e?|i386|ppc(?:64)?)$/.test(a)),
	stdbuf: (t) => skipOpts("stdbuf", t, "", "ioe", (a) => /^--(?:input|output|error)=/.test(a)),
	nice: (t) =>
		skipOpts("nice", t, "", "n", (a) => /^-\d+$/.test(a) || a.startsWith("--adjustment=")),
	timeout: (t) => {
		const r = skipOpts("timeout", t, "v", "sk", (a) =>
			/^--(?:foreground|preserve-status|verbose|signal=.*|kill-after=.*)$/.test(a),
		);
		// The first word after the options is the duration.
		return Array.isArray(r) ? r.slice(1) : r;
	},
	env: (t) => {
		// -S and --split-string turn one word into a command line: not in the list, never followed.
		const r = skipOpts("env", t, "i0v", "uCP", (a) =>
			/^--(?:ignore-environment|null|unset=.*|chdir=.*)$/.test(a),
		);
		if (!Array.isArray(r)) return r;
		let rest = r;
		while (rest[0] === "-") rest = rest.slice(1);
		return dropAssignments(rest);
	},
	// -s and -i run a shell, which then reads stdin or a command line: not in the list.
	sudo: (t) =>
		skipOpts("sudo", t, "EHnkKbPASlv", "ugCpDhrtTU", (a) =>
			/^--(?:preserve-env(?:=.*)?|user=.*|group=.*|non-interactive)$/.test(a),
		),
	doas: (t) => skipOpts("doas", t, "n", "uC"),
	exec: (t) => {
		const r = skipOpts("exec", t, "cl", "a");
		return Array.isArray(r) && r.length === 0 ? null : r;
	},
	command: (t) => {
		if (t.length && /^-[A-Za-z]*[vV]/.test(t[0])) return null;
		return skipOpts("command", t, "p", "");
	},
};
WRAPPERS.gtimeout = WRAPPERS.timeout;

/** Programs that build the command they run from file names or input lines. */
const BUILDS_ITS_COMMAND = new Set(["xargs", "find"]);
/** Programs that run their arguments, joined, as a shell command line. */
const RUNS_A_LINE = new Set(["watch", "parallel"]);

/** How deep a `-c` text, an `eval` or a `watch` line is read for a launch inside it. */
const MAX_INLINE_DEPTH = 3;

type Found = { launch: Launch; direct: boolean } | null;
type Cmd = Pick<SimpleCommand, "raw" | "stdin" | "hereString" | "procSub">;

/** A path run directly that is a shell script on disk (strict), or cannot be told from one. */
function pathIsScript(file: string, cwd: string | undefined, strict: boolean): boolean {
	const abs = path.isAbsolute(file) ? file : cwd ? path.resolve(cwd, file) : null;
	if (abs === null) return !strict;
	const k = execKind(abs);
	return strict ? k === "script" : k !== "other";
}

/**
 * The launch inside a command line that a shell (`-c`), `eval` or `watch` will run, read the
 * same way. Never rebuilt: the bytes it reads cannot be put back into the text.
 */
function inlineLaunch(text: string, cwd: string | undefined, depth: number): Found {
	let cmds: SimpleCommand[];
	try {
		cmds = simpleCommands(text);
	} catch {
		return { launch: odd("the command text is nested too deep to read"), direct: false };
	}
	const hits = cmds
		.map((c) => launchIn(c, cwd, depth + 1))
		.filter((h): h is NonNullable<Found> => h !== null);
	if (!hits.length) return null;
	const o = hits.find((h) => h.launch.form === "odd");
	if (o) return { launch: o.launch, direct: false };
	if (hits.length > 1)
		return { launch: odd("the command text runs more than one script"), direct: false };
	return { launch: hits[0].launch, direct: false };
}

/** The script launch of a shell named as the command, `t[0]`. */
function shellLaunch(
	t: string[],
	c: Cmd,
	cwd: string | undefined,
	depth: number,
	direct: boolean,
): Found {
	const hit = (launch: Launch): Found => ({ launch, direct });
	if (c.hereString || c.procSub)
		return hit(odd("a shell is fed a here-string or a process substitution, not read first"));
	const opts: string[] = [];
	let text = false;
	let fromStdin = false;
	let i = 1;
	for (; i < t.length; i++) {
		const a = t[i];
		if (a === "-") return hit({ form: "stdin" });
		if (a === "--") return hit(odd("the shell is given `--` before the script"));
		if (SHORT_OPTS.test(a)) {
			if (a.slice(1).includes("c")) text = true;
			else if (a.slice(1).includes("s")) fromStdin = true;
			opts.push(a);
			if (/^[-+][A-Za-z]*[oO]$/.test(a)) {
				if (i + 1 >= t.length) return hit(odd(`the shell option ${a} has no name`));
				opts.push(t[++i]);
			}
			continue;
		}
		if (a.startsWith("--")) {
			if (SAFE_LONG.has(a)) {
				opts.push(a);
				continue;
			}
			return hit(odd(`the shell option ${a} cannot be checked`));
		}
		break;
	}
	// -c: the text to run is in the command. It is read the same way: a launch inside it, or
	// text worked out when it runs (`"$(cat FILE)"`, `"$S"`), goes to a person.
	if (text) {
		if (i >= t.length) return hit(odd("the shell is given -c with no command"));
		return inlineLaunch(t[i], cwd, depth);
	}
	// No file: the script comes from stdin. A pipe or a `<` file cannot be read first. A heredoc
	// is in the command (its lines are listed as commands of their own); a bare shell is
	// interactive.
	if (fromStdin || i >= t.length) return c.stdin ? hit({ form: "stdin" }) : null;
	return hit({ form: "shell", argv0: t[0], opts, file: t[i] });
}

/** True when a shell, eval or source among `t`'s arguments is handed options, command text or a file. */
function handsAShell(t: string[], cwd: string | undefined): boolean {
	for (let j = 1; j < t.length; j++) {
		if (!isShell(t[j]) && t[j] !== "eval" && t[j] !== "source") continue;
		const next = t[j + 1];
		if (next === undefined) continue;
		if (/^[-+]/.test(next) || /[$`]/.test(next)) return true;
		const abs = cwd && !path.isAbsolute(next) ? path.resolve(cwd, next) : next;
		try {
			if (statSync(abs, { throwIfNoEntry: false })?.isFile()) return true;
		} catch {
			return true;
		}
	}
	return false;
}

/**
 * The script launch in one simple command, or null when it runs no script file. Fails closed: a
 * shape that cannot be rebuilt into checked bytes is "odd" and goes to a person. `direct` is true
 * only for a launch written first with no wrapper, the shape `rebuild` may put back together.
 */
function launchIn(c: Cmd, cwd: string | undefined, depth = 0): Found {
	if (depth > MAX_INLINE_DEPTH)
		return { launch: odd("the command nests shells too deep to read"), direct: false };
	let t = c.raw;
	let wrapped = false;
	for (let n = 0; t.length && n < 16; n++) {
		const w = Object.hasOwn(WRAPPERS, base(t[0])) ? WRAPPERS[base(t[0])] : undefined;
		if (!w) break;
		const r = w(t.slice(1));
		if (r === null) return null;
		if (!Array.isArray(r)) return { launch: r, direct: false };
		t = r;
		wrapped = true;
	}
	if (!t.length) return null;
	const direct = !wrapped;
	const hit = (launch: Launch): Found => ({ launch, direct });
	const w0 = t[0];
	const b = base(w0);
	// `$(cat FILE)`, a backtick, `$S`: the program and its words come from text not in the command.
	if (/[$`]/.test(w0) || /^[<>=]\(/.test(w0))
		return hit(odd("the command to run is worked out when it runs, so it cannot be read first"));
	if (SHELL_NAMES.has(b)) return shellLaunch(t, c, cwd, depth, direct);
	if (OTHER_SHELLS.has(b)) return hit(odd(`a ${b} script is not read by this check`));
	if (w0 === "eval") {
		if (c.hereString || c.procSub) return hit(odd("eval is fed text that is not read first"));
		return t.length > 1 ? inlineLaunch(t.slice(1).join(" "), cwd, depth) : null;
	}
	if (w0 === "." || w0 === "source") {
		if (c.procSub) return hit(odd("a process substitution is sourced, not read first"));
		return t.length > 1 ? hit({ form: "source", file: t[1], args: t.length - 2 }) : null;
	}
	if (BUILDS_ITS_COMMAND.has(b)) {
		// The command is built from file names or input lines: a shell, eval or source in it is
		// handed text this check never sees. A script run by path is read, never rebuilt.
		let from = 1;
		if (b === "find") {
			from = t.findIndex((w) => /^-(?:exec|execdir|ok|okdir)$/.test(w)) + 1;
			if (from === 0) return null;
		}
		for (let j = from; j < t.length; j++) {
			if (isShell(t[j]) || t[j] === "eval" || t[j] === "source")
				return {
					launch: odd(`${b} hands a shell names it builds, which are not read`),
					direct: false,
				};
			if (t[j].includes("/") && pathIsScript(t[j], cwd, true))
				return { launch: { form: "exec", file: t[j] }, direct: false };
		}
		return null;
	}
	if (RUNS_A_LINE.has(b)) return inlineLaunch(t.slice(1).join(" "), cwd, depth);
	if (w0.includes("/") && pathIsScript(w0, cwd, false)) return hit({ form: "exec", file: w0 });
	// Any other program (ssh, flock, setsid, script, ...) handing a shell a file, options or
	// command text runs a script this check does not read.
	if (!INERT.has(b) && handsAShell(t, cwd))
		return {
			launch: odd(`${b} hands a shell a file or command text, which is not read`),
			direct: false,
		};
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

/** True when `body` itself launches a script, or runs text that is not read: one level only. */
function launchesScript(body: string, cwd: string): boolean {
	return simpleCommands(body).some((c) => launchIn(c, cwd) !== null);
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
			const hit = launchIn(c, cwd);
			if (hit) found.push({ launch: hit.launch, first: i === 0 && hit.direct });
		});
		if (!found.length) return NONE;
		const o = found.find((f) => f.launch.form === "odd");
		if (o?.launch.form === "odd") return unchecked(o.launch.why);
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
			return unchecked("the script runs another script, or command text, which is not read");
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
