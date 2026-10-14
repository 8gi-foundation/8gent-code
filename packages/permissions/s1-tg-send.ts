/**
 * System One: the tg-notify send recipe, run as a two-line script, to a loopback Bot API (#4101).
 *
 * Pilot msg-post-caption (12 Oct 2026, run 185657): POSTING.md prescribes
 * `. ~/.config/tg-notify/bot.env` then `curl -sS -X POST
 * "$TELEGRAM_API_BASE/bot$TELEGRAM_BOT_TOKEN/sendMessage" --data-urlencode ...`. The model joined
 * the two with `&&` (refused by the shell sanitizer: no chaining), wrote the same two lines into
 * .tmp/send.sh and ran `sh .tmp/send.sh`. No lane read it, the judge scored pYes 0.61 (block), and
 * nothing was posted. The judge cannot see that bot.env points at 127.0.0.1. This lane reads the
 * script and bot.env instead. Same design as s1-curl-loopback.ts (#3941) and s1-login-line.ts
 * (#4072): an ALLOWLIST of one exact shape, never a deny-list. Anything else is "no opinion" and the
 * command goes to the rules and the judge as before.
 *
 * `tgSendFromEnv` answers ok (default mode only) when ALL hold:
 *   - the command is exactly `sh FILE` or `bash FILE`, FILE a plain relative path to a regular file
 *     inside the workspace (no `..`, no dot directory but `.tmp`, no symlink below the root, not a
 *     secret name, at most 4 KiB, printable ASCII);
 *   - the file, after joining `\`-newline continuations and dropping blank lines, one optional
 *     shebang (`#!/bin/sh`, `#!/bin/bash`, `#!/usr/bin/env sh|bash`) and then one optional
 *     `set -e` / `set -eu` / `set -ue` (#4232: it only stops the script sooner), is exactly two lines:
 *       `. ~/.config/tg-notify/bot.env` (or `source`, or `$HOME/...` / `"$HOME/..."`), then
 *       `curl [-q] OPTS "$TELEGRAM_API_BASE/bot$TELEGRAM_BOT_TOKEN/sendMessage" OPTS` where OPTS are
 *       only -s, -S, -f (or their long names), `-X POST`, `-m`/`--max-time`/`--connect-timeout N`,
 *       and exactly two `--data-urlencode`: `chat_id=<integer>` and either `text@FILE` (a regular
 *       workspace file under the same rules, at most 4 KiB, optionally written `$(pwd)/FILE` or
 *       `$PWD/FILE`) or `text=<literal>`. `${NAME}` spellings are accepted. No other `$`, backtick,
 *       backslash or `!` anywhere, no unquoted `$`, no redirect, no pipe, no output file;
 *   - or those two lines with ONE message assignment directly before the curl line (#4250: a
 *     caption is multi-line by definition): `MSG='<text>'` (or MESSAGE, TEXT, CAPTION), a single
 *     quoted literal that may span lines, printable ASCII and newlines only, no quote character
 *     inside. Single quotes expand nothing. The curl line may then send it only as exactly
 *     `--data-urlencode "text=$MSG"` (or `${MSG}`), the one place that name may appear. The name
 *     list is closed: none of them is read by sh or curl, so the assignment changes nothing but
 *     the message;
 *   - ~/.config/tg-notify/bot.env (HOME from the environment) is a regular file, not a symlink, at
 *     most 4 KiB, whose every line is blank, a `#` comment, or `TELEGRAM_<NAME>=<plain value>`
 *     (optionally double-quoted, no `$`, backtick, quote, space or `\`). Sourcing it therefore sets
 *     only TELEGRAM_* variables, never PATH or a curl or shell setting;
 *   - its TELEGRAM_API_BASE is `http(s)://` 127.0.0.1, localhost or [::1] with an optional port and no
 *     path, and TELEGRAM_BOT_TOKEN is set. The token therefore goes only to this machine. On a real
 *     machine (api.telegram.org) the lane has no opinion and the judge, then the person, decide;
 *   - no proxy variable and no curlrc unless `-q` is first (curlEnvRefusal), no BASH_ENV, ENV,
 *     SHELLOPTS, BASHOPTS, PS4 or IFS, no exported shell function (BASH_FUNC_*): nothing can run
 *     before or instead of curl, and xtrace cannot print the expanded URL (8SO, #4102);
 *   - every PATH entry is absolute and resolves outside the workspace (pathOutsideWorkspace, shared
 *     with the deck-render lane) and, after a `cd <folder> &&`, outside the project around it: sh
 *     and curl cannot be found in either;
 *   - TELEGRAM_API_BASE and TELEGRAM_BOT_TOKEN are not in the environment: when sourcing bot.env
 *     fails (dash has no `source`; bash outside POSIX mode goes on past a missing `.` file), curl
 *     must find no base and no token, never inherited ones (8SO, #4102);
 *   - a `\`-newline is removed as sh removes it, outside quotes only; any other backslash, or a
 *     quote spanning a line, is no opinion (8SO, #4102);
 *   - the script and the text@ file each have one link (nlink 1): a hardlink to a file outside the
 *     workspace (a $HOME secret) is not a workspace file.
 *
 * The caller runs the checked bytes, not the path (8SO, #4102): an ok carries `body`, and the gate
 * allows only when its caller opted in (`canRunInstead`) and hands back `runInstead`, which the
 * executor runs with `/bin/sh -c` in place of `sh FILE`. A write_file racing this run_command (the
 * SDK starts same-step tool calls together) can change the file, never what runs. A caller that
 * cannot run the body (a background shell spawn) never gets this lane's allow.
 *
 * Deterministic refusals (a block with the way forward, no judge), in any System One mode:
 *   - TG_TOKEN_IN_ARGV_REFUSAL: any command (curl in any spelling, wget, anything), or the script
 *     above, with a Bot API token written in it (the `<digits>:<secret>` shape, or bot.env's own token). A secret in argv shows in the
 *     process list, the transcript and the session log; the model is told to source the env file;
 *   - CURL_L_REFUSAL (from s1-curl-loopback.ts): the script's curl uses -L/--location.
 *
 * What leaves the box: text@ reads only a workspace file and sends it only to the loopback base in
 * bot.env. Accepted residuals, on purpose (8SO, #4102): a local port that forwards off the machine
 * (an ssh -L or a proxy listening on 127.0.0.1) carries the message and the token wherever it goes;
 * the text file can still change between this check and the spawn (TOCTOU, as for the sibling
 * lanes), and that change can only reach the same loopback base. bot.env can change in that window
 * too, and a changed bot.env is sourced as shell, so it is NOT bounded the same way: it is accepted
 * only because it lives outside the workspace, where write_file and edit_file cannot reach
 * (safePath), and any run_command that writes it passes its own gate first. The token is never in
 * the command the model wrote or the session log, but sh expands it into curl's own argv, so it is
 * visible in this user's process list for the length of the request. Only the sendMessage method.
 *
 * Synchronous, never throws.
 */

import { lstatSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { curlEnvRefusal } from "../decide/allowlist";
import { promptControlText } from "../decide/guard";
import { decideRules } from "../decide/rules";
import { CURL_L_REFUSAL } from "./s1-curl-loopback";
import { pathOutsideWorkspace } from "./s1-deck-render";
import { protectedRel, relSegments } from "./s1-mv-in-project";
import { inside } from "./s1-rm-nothing";
import { SECRET, canon, symlinkBelow } from "./s1-run-in-project";

type Env = Record<string, string | undefined>;

/** `body` is the exact script text that was checked: the caller runs it in place of `sh FILE`. */
export type TgSend = { ok: true; reason: string; body: string } | { ok: false; refuse?: string };
const NO: TgSend = { ok: false };

/** Told to the model when a Bot API token is written into a command or the send script. */
export const TG_TOKEN_IN_ARGV_REFUSAL =
	'Refused: a bot token is written into the command. Never put a token in a command, a script or a message. Write a script with exactly two lines, `. ~/.config/tg-notify/bot.env` and `curl -sS -X POST "$TELEGRAM_API_BASE/bot$TELEGRAM_BOT_TOKEN/sendMessage" --data-urlencode "chat_id=<id>" --data-urlencode "text@.tmp/<message file>"`, then run `sh <script>`.';

/** The Bot API token shape: a numeric bot id, a colon, a long secret. */
const TOKEN_SHAPE = /\d{6,12}:[A-Za-z0-9_-]{30,}/;
const MAX_BYTES = 4096;
const SCRIPT_CMD =
	/^(sh|bash) (?:\.\/)?([A-Za-z0-9][A-Za-z0-9._/-]{0,199}|\.tmp\/[A-Za-z0-9._/-]{1,195})$/;
const SHEBANG = /^#!(\/bin\/(sh|bash)|\/usr\/bin\/env (sh|bash))$/;
/**
 * One optional errexit line right after the shebang (#4232): `set -e`, `set -eu` or `set -ue`.
 * It only ever stops the script sooner (a failed `.` of bot.env, an unset variable), so curl runs
 * in fewer cases, never more. No other `set` option: -x/-v would trace the expanded token.
 */
const ERREXIT = /^set -(e|eu|ue)$/;
const SOURCE =
	/^(\.|source) (~\/\.config\/tg-notify\/bot\.env|\$HOME\/\.config\/tg-notify\/bot\.env|"\$HOME\/\.config\/tg-notify\/bot\.env")$/;
const ENV_LINE = /^(TELEGRAM_[A-Z0-9_]{1,40})=("[A-Za-z0-9._:/@+[\]-]*"|[A-Za-z0-9._:/@+[\]-]*)$/;
const API_BASE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?\/?$/i;
const UNQUOTED = /^[A-Za-z0-9._/+,=@:%-]$/;
const NUM = /^\d{1,4}(\.\d{1,3})?$/;
const CHAT = /^chat_id=-?\d{1,20}$/;
/**
 * The one message assignment (#4250): a closed list of names sh and curl never read, then a single
 * quoted literal of printable ASCII and newlines with no quote character inside.
 */
const MSG_ASSIGN = /^(MSG|MESSAGE|TEXT|CAPTION)='([\x20-\x21\x23-\x26\x28-\x7e\n]*)'$/;
/** Set in the environment, any of these runs code, changes parsing, or traces the token (8SO, #4102). */
const SHELL_ENV = new Set(["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "PS4", "IFS"]);
/** The two variables the curl line expands: only bot.env may set them (8SO, #4102). */
const INHERITED = new Set(["TELEGRAM_API_BASE", "TELEGRAM_BOT_TOKEN"]);

/** Sentinels for the only expansions allowed, inside double quotes. */
const BASE = "\u0001B";
const TOK = "\u0001T";
const PWD = "\u0001P";
const MSGV = "\u0001M";
const URL_WORD = `${BASE}/bot${TOK}/sendMessage`;

/** `rel` with `/` separators: the reason names the path as the model wrote it, on every host. */
const slash = (rel: string): string => rel.split(path.sep).join("/");

/** The workspace-relative path of `p`, resolved, or null when it leaves the workspace. */
function relInside(p: string, root: string): { abs: string; rel: string; lexical: string } | null {
	if (p.split("/").includes("..")) return null;
	const lexical = path.resolve(root, p);
	const abs = canon(lexical);
	if (!inside(abs, root) || !inside(lexical, root)) return null;
	const rel = path.relative(root, abs);
	if (rel === "" || SECRET.test(rel) || protectedRel(rel)) return null;
	return { abs, rel, lexical };
}

/** A small regular workspace file the lane may read (the script or the message), or null. */
function workspaceFile(p: string, root: string): { abs: string; rel: string } | null {
	const f = relInside(p, root);
	if (!f) return null;
	if (relSegments(f.rel).some((s) => s.startsWith(".") && s !== ".tmp")) return null;
	if (/\.env$/i.test(path.basename(f.rel))) return null;
	if (symlinkBelow(root, f.lexical)) return null;
	const st = lstatSync(f.abs, { throwIfNoEntry: false });
	// nlink 1: a hardlink to a file outside the workspace passes every path check above (8SO, #4102).
	if (!st || !st.isFile() || st.nlink !== 1 || st.size > MAX_BYTES) return null;
	return { abs: f.abs, rel: f.rel };
}

/** bot.env parsed, when it is plain TELEGRAM_* assignments only; else null. */
function readBotEnv(env: Env): Map<string, string> | null {
	const home = env.HOME;
	if (!home || !path.isAbsolute(home)) return null;
	const file = path.join(home, ".config", "tg-notify", "bot.env");
	const st = lstatSync(file, { throwIfNoEntry: false });
	if (!st || !st.isFile() || st.size > MAX_BYTES) return null;
	const text = readFileSync(file, "utf8");
	// Printable ASCII, tab and newline only, and no trim(): JS trim() strips U+00A0 and U+FEFF, which
	// sh does not, so a line led by one would pass here and run as a command there (8SO, #4102).
	if (/[^\x20-\x7e\n\t]/.test(text)) return null;
	const vars = new Map<string, string>();
	for (const line of text.split("\n")) {
		if (/^[ \t]*$/.test(line) || /^[ \t]*#/.test(line)) continue;
		const m = ENV_LINE.exec(line);
		if (!m) return null;
		vars.set(m[1], m[2].replace(/^"|"$/g, ""));
	}
	return vars;
}

/** True when `text` carries a Bot API token: the generic shape, or bot.env's own token. */
function hasToken(text: string, env: Env): boolean {
	if (TOKEN_SHAPE.test(text)) return true;
	try {
		const tok = readBotEnv(env)?.get("TELEGRAM_BOT_TOKEN");
		return !!tok && tok.length >= 8 && text.includes(tok);
	} catch {
		return false;
	}
}

/** `text` with every Bot API token replaced by `<token>`, so a refusal never echoes the secret. */
export function redactBotToken(text: string, env: Env = process.env): string {
	let out = text.replace(new RegExp(TOKEN_SHAPE.source, "g"), "<token>");
	try {
		const tok = readBotEnv(env)?.get("TELEGRAM_BOT_TOKEN");
		if (tok && tok.length >= 8) out = out.split(tok).join("<token>");
	} catch {
		// Keep the shape-only redaction.
	}
	return out;
}

/** Split the curl line into words; the three allowed expansions become sentinels. Null on anything else. */
function splitWords(text: string, msgName?: string): string[] | null {
	if (/[^\x20-\x7e]/.test(text)) return null;
	const words: string[] = [];
	let cur = "";
	let has = false;
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === " " || c === "\t") {
			if (has) words.push(cur);
			cur = "";
			has = false;
			i++;
		} else if (c === "'") {
			const end = text.indexOf("'", i + 1);
			if (end === -1) return null;
			cur += text.slice(i + 1, end);
			has = true;
			i = end + 1;
		} else if (c === '"') {
			const end = text.indexOf('"', i + 1);
			if (end === -1) return null;
			const body = text
				.slice(i + 1, end)
				.replace(/\$\{TELEGRAM_API_BASE\}|\$TELEGRAM_API_BASE(?![A-Za-z0-9_])/g, BASE)
				.replace(/\$\{TELEGRAM_BOT_TOKEN\}|\$TELEGRAM_BOT_TOKEN(?![A-Za-z0-9_])/g, TOK)
				.replace(/\$\(pwd\)\/|\$\{PWD\}\/|\$PWD\//g, `${PWD}/`)
				.replace(
					msgName ? new RegExp(`\\$\\{${msgName}\\}|\\$${msgName}(?![A-Za-z0-9_])`, "g") : /(?!)/g,
					MSGV,
				);
			if (/[$`\\!]/.test(body)) return null;
			cur += body;
			has = true;
			i = end + 1;
		} else if (UNQUOTED.test(c)) {
			if (c === "=" && !has) return null;
			cur += c;
			has = true;
			i++;
		} else return null;
	}
	if (has) words.push(cur);
	return words;
}

/**
 * `body` with each `\`-newline outside quotes removed, exactly as sh removes it (no space put in its
 * place), or null for any other backslash or a double quote that spans a line. Replacing it with a space,
 * as this lane first did, split `"text@.tmp/m"\`-newline`-s` into a checked `.tmp/m` while sh read
 * `.tmp/m-s`, a symlink to any file on the machine, and posted it (8SO, #4102). A newline inside
 * single quotes is kept as sh keeps it (#4250); scriptLines then holds that quote on one logical
 * line, and only the message assignment may carry it.
 */
function joinContinuations(body: string): string | null {
	let out = "";
	let quote: string | null = null;
	for (let i = 0; i < body.length; i++) {
		const c = body[i];
		if (quote !== null) {
			if (c === "\\" || (c === "\n" && quote !== "'")) return null;
			if (c === quote) quote = null;
			out += c;
		} else if (c === "\\") {
			if (body[i + 1] !== "\n") return null;
			i++;
		} else {
			if (c === "'" || c === '"') quote = c;
			out += c;
		}
	}
	return quote === null ? out : null;
}

/** `joined` split at each newline outside quotes: a single quoted literal stays on its line. */
function logicalLines(joined: string): string[] {
	const lines: string[] = [];
	let cur = "";
	let quote: string | null = null;
	for (const c of joined) {
		if (quote !== null) {
			if (c === quote) quote = null;
		} else if (c === "'" || c === '"') quote = c;
		else if (c === "\n") {
			lines.push(cur);
			cur = "";
			continue;
		}
		cur += c;
	}
	lines.push(cur);
	return lines;
}

/** The script's source and curl lines, and the message variable name when it assigns one. */
type Lines = { source: string; curl: string; msgName?: string };

/** The script's lines, or null when it is not exactly the recipe's layout. */
function scriptLines(body: string): Lines | null {
	if (/[^\x20-\x7e\n\t]/.test(body)) return null;
	const joined = joinContinuations(body);
	if (joined === null) return null;
	const lines = logicalLines(joined)
		.map((l) => l.trim())
		.filter((l) => l !== "");
	if (lines.length > 0 && SHEBANG.test(lines[0])) lines.shift();
	if (lines.length > 0 && ERREXIT.test(lines[0])) lines.shift();
	if (lines.length === 2) return { source: lines[0], curl: lines[1] };
	if (lines.length !== 3) return null;
	// Only the message assignment may hold a newline; every other line is one physical line.
	const m = MSG_ASSIGN.exec(lines[1]);
	if (!m || lines[0].includes("\n") || lines[2].includes("\n")) return null;
	return { source: lines[0], curl: lines[2], msgName: m[1] };
}

/** The curl line checked word by word: ok, a refusal, or null (no opinion). */
function curlLine(
	line: string,
	root: string,
	env: Env,
	msgName?: string,
): { ok: true; rel: string | null; msg: boolean } | { refuse: string } | null {
	const words = splitWords(line, msgName);
	if (!words || words.length < 2 || words.length > 20 || words[0] !== "curl") return null;
	let i = 1;
	const qFirst = words[1] === "-q" || words[1] === "--disable";
	if (qFirst) i = 2;
	if (curlEnvRefusal(qFirst, env as NodeJS.ProcessEnv) !== null) return null;
	let url = 0;
	let chat = 0;
	let text = 0;
	let rel: string | null = null;
	let msg = false;
	let location = false;
	for (; i < words.length; i++) {
		const w = words[i];
		// A sentinel anywhere but the URL word (or a $(pwd)/ prefix of text@) is a stray expansion.
		if (w === URL_WORD) {
			url++;
			continue;
		}
		if (w.includes(BASE) || w.includes(TOK) || w.includes(MSGV)) return null;
		if (/^-[sSf]+$/.test(w)) continue;
		if (["--silent", "--show-error", "--fail", "--fail-with-body"].includes(w)) continue;
		if (w === "-L" || w === "--location" || /^-[sSfL]+$/.test(w)) {
			location = true;
			continue;
		}
		if (i + 1 >= words.length) return null;
		const v = words[++i];
		if (v.includes(BASE) || v.includes(TOK)) return null;
		// The message variable only as the whole text value: `"text=$MSG"` (#4250).
		if (v.includes(MSGV)) {
			if (w !== "--data-urlencode" || v !== `text=${MSGV}`) return null;
			msg = true;
			text++;
			continue;
		}
		if (w === "-X" || w === "--request") {
			if (v !== "POST") return null;
		} else if (w === "-m" || w === "--max-time" || w === "--connect-timeout") {
			if (!NUM.test(v)) return null;
		} else if (w === "--data-urlencode") {
			if (CHAT.test(v)) chat++;
			else if (v.startsWith("text=")) {
				if (v.includes(PWD)) return null;
				text++;
			} else if (v.startsWith("text@")) {
				let p = v.slice(5);
				if (p.startsWith(`${PWD}/`)) p = p.slice(PWD.length + 1);
				if (p.includes(PWD) || path.isAbsolute(p)) return null;
				const f = workspaceFile(p, root);
				if (!f) return null;
				rel = f.rel;
				text++;
			} else return null;
		} else return null;
	}
	if (url !== 1 || chat !== 1 || text !== 1) return null;
	if (location) return { refuse: CURL_L_REFUSAL };
	return { ok: true, rel, msg };
}

/**
 * ok when `command` runs the tg-notify send recipe against a loopback Bot API; a refusal when a
 * token is written into a curl command or the script; else no opinion. See the header.
 */
export function tgSendFromEnv(
	command: string,
	cwd: string | undefined,
	env: Env = process.env,
	/** The project root when `cwd` is a folder a `cd <folder> &&` chose inside it (#3199). */
	project?: string,
): TgSend {
	try {
		const text = command.trim();
		// Any command, not only one spelled `curl `: `/usr/bin/curl`, `command curl` or wget put
		// the token in argv just the same (8SO, #4102).
		if (hasToken(text, env)) return { ok: false, refuse: TG_TOKEN_IN_ARGV_REFUSAL };
		if (/^curl\s/.test(text)) return NO;
		if (!cwd || !path.isAbsolute(cwd)) return NO;
		const m = SCRIPT_CMD.exec(text);
		if (!m || promptControlText(text) !== null || decideRules(text).rules.length !== 0) return NO;
		const root = canon(cwd);
		const script = workspaceFile(m[2], root);
		if (!script) return NO;
		const body = readFileSync(script.abs, "utf8");
		const lines = scriptLines(body);
		if (!lines || !SOURCE.test(lines.source) || !/^curl\s/.test(lines.curl)) return NO;
		if (hasToken(body, env)) return { ok: false, refuse: TG_TOKEN_IN_ARGV_REFUSAL };
		for (const k of Object.keys(env)) {
			if (SHELL_ENV.has(k) && env[k] !== undefined) return NO;
			if (k.startsWith("BASH_FUNC_")) return NO;
			// Inherited, these are what curl uses when sourcing bot.env fails and the shell goes on:
			// dash has no `source`, bash outside POSIX mode survives a missing `.` file (8SO, #4102).
			if (INHERITED.has(k) && env[k] !== undefined) return NO;
		}
		const pathEnv = env.PATH ?? process.env.PATH ?? "";
		if (!pathOutsideWorkspace(root, pathEnv)) return NO;
		// After a `cd <folder> &&` the cwd is that folder; the project around it is workspace too.
		if (project !== undefined && !pathOutsideWorkspace(canon(project), pathEnv)) return NO;
		const vars = readBotEnv(env);
		if (!vars || !vars.get("TELEGRAM_BOT_TOKEN")) return NO;
		const base = API_BASE.exec(vars.get("TELEGRAM_API_BASE") ?? "");
		if (!base) return NO;
		if (base[1] !== undefined && (Number(base[1]) < 1 || Number(base[1]) > 65535)) return NO;
		const c = curlLine(lines.curl, root, env, lines.msgName);
		if (!c) return NO;
		if ("refuse" in c) return { ok: false, refuse: c.refuse };
		return {
			ok: true,
			body,
			reason: `tg-notify sendMessage from ${slash(script.rel)} to the loopback Bot API in bot.env (${vars.get("TELEGRAM_API_BASE")}), token read from the env file${c.rel ? `, text from ${slash(c.rel)}` : ""}${c.msg ? `, text from the ${lines.msgName} literal in the script` : ""}`,
		};
	} catch {
		return NO;
	}
}
