/**
 * System One: a plain curl to the scenario's own loopback server (#3941).
 *
 * Pilot browser-op-practice (11 Oct 2026): the model drove the scenario's web
 * stub with `curl -s -c .tmp/cookies.txt -b .tmp/cookies.txt -L -D
 * .tmp/headers.txt http://127.0.0.1:PORT/...`. The judge has no network or
 * filesystem to look at and scored it just over the line (pYes 0.56 and 0.58),
 * so login never happened. This lane reads the command instead. Same design as
 * s1-run-in-project.ts (#3938): an ALLOWLIST, never a deny-list. Anything not
 * understood is "no opinion" and the command goes to the rules and the judge
 * as before. The gate calls this only in System One's default mode.
 *
 * `curlToLoopback` answers ok only when ALL hold:
 *   - the command is `curl [-q] <options and URLs>` written in a tiny shell
 *     subset: unquoted words use plain characters only (no `$`, backtick, `\`,
 *     `~`, `*`, `?`, `&`, `;`, `|`, `<`, `>`, `(`, `{`, `#`, `!`, `[`, no
 *     leading `=`), single quotes hold anything printable but `'`, double
 *     quotes anything printable but `"`, `$`, backtick, `\` and `!`. No
 *     pipes, redirects, substitution or env assignments. decideRules fires
 *     nothing and there is no prompt-control text;
 *   - every option is on the allowlist below and written exactly (no `--x=y`
 *     form, no abbreviation, no `--`). Anything else, including -K/--config,
 *     --proxy/-x, --unix-socket, --resolve, --connect-to, --proto*, --next,
 *     --output-dir, -L, -O, --trace*, --stderr, -w with `@file` or `%output{}`, is
 *     refused;
 *   - every URL is `http://` or `https://` plus 127.0.0.1, localhost or [::1],
 *     then an optional port (1 to 65535) and a path. No userinfo, no `{}` or
 *     `[]` glob, no other scheme, no scheme-less guess, at least one URL;
 *   - every file the command reads (-b when a file, -T, -d/--data/
 *     --data-binary/--data-ascii/--data-urlencode `@file`, -F `name=@file`,
 *     `name=<file`) resolves, after realpath of its nearest existing part,
 *     inside the workspace: not a secret, not a protected path, no dot
 *     directory except `.tmp`. Every file it writes (-o, -c, -D) must be
 *     under the workspace's `.tmp/` (realpath again) and not source or
 *     config. `-` (stdout) is fine for output, never for input; `/dev/null`
 *     is fine for output. -O is refused (it writes into the working
 *     directory, not `.tmp/`). -F/--form values may carry only `type=` and
 *     `filename=` options after `;` (`headers=@file` reads a file);
 *   - no http(s)/ALL proxy variable in the environment (curl would send the
 *     loopback request to the proxy, body and all), and no curlrc in $CURL_HOME,
 *     $XDG_CONFIG_HOME, ~ or ~/.config unless `-q` is the first argument.
 *
 * Redirects (-L/--location) are refused. curl cannot be told "loopback only"
 * for redirects (--proto-redir limits the scheme, never the host), so a hop
 * could reach 169.254.169.254 or the LAN (SSRF) with whatever the request
 * carries. A curl with -L goes to the judge as before. To follow a 302, make a
 * second loopback request to the Location it returned; this lane allows that.
 *
 * Known limits, on purpose: only POSIX single or double quoting; no `-d` with
 * `&` unquoted; multiple files in -F `@a,b` are refused. TOCTOU (out of scope,
 * accepted by 8SO): a path can be swapped for a symlink between this check and
 * the spawn, the same window as s1-rm-single.ts and s1-run-in-project.ts.
 *
 * Synchronous, never throws.
 */

import { lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { curlEnvRefusal } from "../decide/allowlist";
import { promptControlText } from "../decide/guard";
import { decideRules } from "../decide/rules";
import { protectedRel } from "./s1-mv-in-project";
import { inside } from "./s1-rm-nothing";
import { SECRET, WRITE_BAD_NAME, canon, symlinkBelow } from "./s1-run-in-project";

export type CurlLoopback = { ok: true; reason: string } | { ok: false };
const NO: CurlLoopback = { ok: false };

const MAX_WORDS = 60;
const MAX_URLS = 6;
const UNQUOTED = /^[A-Za-z0-9._/+,=@:%-]$/;
const NUM = /^\d{1,6}(\.\d{1,3})?$/;
const METHOD = /^[A-Z]{3,10}$/;
const URL_RE =
	/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?(?:\/[^\s{}[\]\\]*)?$/i;

/** Options taking no value. */
const BOOL_SHORT = new Set(["s", "S", "f", "i", "I", "v", "G"]);
const BOOL_LONG = new Map<string, string>([
	["--silent", "s"],
	["--show-error", "S"],
	["--fail", "f"],
	["--fail-with-body", "f"],
	["--include", "i"],
	["--head", "I"],
	["--verbose", "v"],
	["--get", "G"],
	["--compressed", "z"],
	["--create-dirs", "z"],
	["--no-progress-meter", "z"],
]);
/** Options taking a value: short letter or long name -> canonical key. */
const VAL_SHORT = new Map<string, string>([
	["o", "o"],
	["c", "c"],
	["b", "b"],
	["D", "D"],
	["T", "T"],
	["d", "d"],
	["F", "F"],
	["H", "H"],
	["X", "X"],
	["m", "m"],
	["w", "w"],
]);
const VAL_LONG = new Map<string, string>([
	["--output", "o"],
	["--cookie-jar", "c"],
	["--cookie", "b"],
	["--dump-header", "D"],
	["--upload-file", "T"],
	["--data", "d"],
	["--data-ascii", "d"],
	["--data-binary", "d"],
	["--data-raw", "raw"],
	["--data-urlencode", "urlenc"],
	["--form", "F"],
	["--form-string", "fstr"],
	["--header", "H"],
	["--request", "X"],
	["--max-time", "m"],
	["--connect-timeout", "m"],
	["--max-redirs", "m"],
	["--write-out", "w"],
	["--url", "url"],
]);

type Word = string;

/** Split into words under the small quoting subset, or null when anything else appears. */
function splitWords(text: string): Word[] | null {
	if (/[^\x20-\x7e]/.test(text)) return null;
	const words: Word[] = [];
	let cur = "";
	let has = false;
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === " ") {
			if (has) words.push(cur);
			cur = "";
			has = false;
			i++;
		} else if (c === "'" || c === '"') {
			const end = text.indexOf(c, i + 1);
			if (end === -1) return null;
			const body = text.slice(i + 1, end);
			if (c === '"' && /[$`\\!]/.test(body)) return null;
			cur += body;
			has = true;
			i = end + 1;
		} else if (UNQUOTED.test(c)) {
			if (c === "=" && !has) return null; // zsh expands a leading =word
			cur += c;
			has = true;
			i++;
		} else return null;
	}
	if (has) words.push(cur);
	return words;
}

interface St {
	root: string;
	urls: string[];
}

/** Check one file the command touches. `-` is stdout for writes only. */
function fileOk(p: string, st: St, write: boolean): boolean {
	if (p === "-") return write;
	if (write && p === "/dev/null") return true;
	if (!p || p.includes("{") || p.includes("}") || SECRET.test(p)) return false;
	// A ".." after a symlink means something else to the OS than to path.resolve.
	if (p.split("/").includes("..")) return false;
	const lexical = path.isAbsolute(p) ? path.normalize(p) : path.resolve(st.root, p);
	const abs = canon(lexical);
	if (!inside(abs, st.root)) return false;
	const rel = path.relative(st.root, abs);
	if (rel === "" || SECRET.test(rel) || protectedRel(rel)) return false;
	const segs = rel.split("/");
	if (segs.some((s) => s.startsWith(".") && s !== ".tmp")) return false;
	if (write) {
		// Outputs only under the workspace's .tmp/ directory.
		if (segs[0] !== ".tmp" || segs.length < 2 || segs.includes("node_modules")) return false;
		if (WRITE_BAD_NAME.test(path.basename(abs))) return false;
		// .tmp must be a real directory inside the workspace (absent is fine: nothing to redirect),
		// and no component under it, a dangling final one included, may be a symlink.
		const tmp = path.join(st.root, ".tmp");
		const tst = lstatSync(tmp, { throwIfNoEntry: false });
		if (tst && (tst.isSymbolicLink() || !tst.isDirectory() || realpathSync(tmp) !== tmp))
			return false;
		if (!inside(lexical, st.root) || symlinkBelow(st.root, lexical)) return false;
	}
	return true;
}

function urlOk(u: string): boolean {
	const m = URL_RE.exec(u);
	if (!m) return false;
	if (m[1] !== undefined) {
		const port = Number(m[1]);
		if (port < 1 || port > 65535) return false;
	}
	return true;
}

/** Apply one option with its value; false refuses. */
function applyValue(key: string, v: string, st: St): boolean {
	switch (key) {
		case "o":
		case "c":
		case "D":
			return fileOk(v, st, true);
		case "b":
			if (v === "") return true;
			if (v.includes("=")) {
				return true;
			}
			return fileOk(v, st, false);
		case "T":
			return fileOk(v, st, false);
		case "d": {
			return v.startsWith("@") ? fileOk(v.slice(1), st, false) : true;
		}
		case "raw":
			return true;
		case "urlenc": {
			const at = v.indexOf("@");
			const eq = v.indexOf("=");
			if (at !== -1 && (eq === -1 || at < eq)) return fileOk(v.slice(at + 1), st, false);
			return true;
		}
		case "F": {
			const eq = v.indexOf("=");
			if (eq === -1) return false;
			const [val, ...opts] = v.slice(eq + 1).split(";");
			// Only type= and filename= may follow; headers=@file reads a file.
			if (opts.some((o) => !/^(type|filename)=[A-Za-z0-9._/+-]*$/.test(o))) return false;
			if (/headers\s*=/i.test(v)) return false;
			if (val.startsWith("@") || val.startsWith("<")) {
				const file = val.slice(1);
				if (file.includes(",") || file.includes('"')) return false;
				return fileOk(file, st, false);
			}
			return true;
		}
		case "fstr":
			return true;
		case "H":
			return !v.startsWith("@");
		case "X":
			return METHOD.test(v);
		case "m":
			return NUM.test(v);
		case "w":
			return !v.includes("@") && !/%\{?output/i.test(v) && !v.includes("%{stderr}");
		case "url":
			st.urls.push(v);
			return true;
		default:
			return false;
	}
}

/**
 * ok when `command` is a curl whose every URL is loopback and every file it
 * reads or writes is inside the workspace; see the header.
 */
export function curlToLoopback(command: string, cwd: string | undefined): CurlLoopback {
	try {
		if (!cwd || !path.isAbsolute(cwd)) return NO;
		const text = command.trim();
		if (!text.startsWith("curl ") || promptControlText(text) !== null) return NO;
		if (decideRules(text).rules.length !== 0) return NO;
		const words = splitWords(text);
		if (!words || words.length < 2 || words.length > MAX_WORDS || words[0] !== "curl") return NO;

		const st: St = {
			root: canon(cwd),
			urls: [],
		};
		let i = 1;
		const qFirst = words[1] === "-q" || words[1] === "--disable";
		if (qFirst) i = 2;
		// Proxy variable, or a curlrc without -q first: curl would leave the box or read config.
		if (curlEnvRefusal(qFirst) !== null) return NO;
		for (; i < words.length; i++) {
			const w = words[i];
			if (w === "-" || w === "--") return NO;
			if (w.startsWith("--")) {
				if (BOOL_LONG.has(w)) continue;
				const key = VAL_LONG.get(w);
				if (key === undefined || i + 1 >= words.length) return NO;
				if (!applyValue(key, words[++i], st)) return NO;
				continue;
			}
			if (w.startsWith("-")) {
				// A cluster of short options; one that takes a value ends it.
				for (let j = 1; j < w.length; j++) {
					const c = w[j];
					if (BOOL_SHORT.has(c)) continue;
					const key = VAL_SHORT.get(c);
					if (key === undefined) return NO;
					const rest = w.slice(j + 1);
					let value = rest;
					if (rest === "") {
						if (i + 1 >= words.length) return NO;
						value = words[++i];
					}
					if (!applyValue(key, value, st)) return NO;
					break;
				}
				continue;
			}
			st.urls.push(w);
		}
		if (st.urls.length === 0 || st.urls.length > MAX_URLS || !st.urls.every(urlOk)) return NO;
		return {
			ok: true,
			reason: `curl to a loopback server (${st.urls.length} URL${st.urls.length === 1 ? "" : "s"}) touching only files inside the workspace`,
		};
	} catch {
		return NO;
	}
}
