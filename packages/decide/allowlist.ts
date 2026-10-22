/**
 * Rules-first allowlist for System One (#3131): lets plainly read-only shell
 * commands run without asking the model judge.
 *
 * Why: the ladder in #3131 re-judged 432 real pilot calls. The model judge
 * stopped 80 that the rules pass (about 1 in 5), mostly `cd <dir> && bun test`
 * and plain inspection. Commands like these never needed a model.
 *
 * It answers only "pass-without-model" or "no-opinion". It can NEVER allow a
 * command the rules escalate or block: decideRules and the prompt-control
 * check run first, and anything but a clean rules pass is "no-opinion". So it
 * can only remove a model call, never a rule.
 *
 * "pass-without-model" needs ALL of:
 *   - decideRules says pass and there is no prompt-control text;
 *   - no command, process or arithmetic substitution, backtick, heredoc or
 *     unquoted `$` expansion other than `$?`;
 *   - every redirect goes to /dev/null, a temp path or another fd, never a file;
 *   - every segment is a bare read-only binary (READ_ONLY_BINS, with the
 *     per-binary argument checks below), `cd`, a read-only git subcommand, an
 *     additive command (see below), or, only when `bunTest` is set, `bun test`;
 *   - no argument names a secret (.env, keys, credentials).
 *
 * Additive commands (#3131 live measurement: one unlisted `mkdir -p deck` or
 * `bun --version` was enough to load the whole judge into a session):
 *   - `mkdir [-p] [-v] <path>...` where every path is relative, inside the
 *     working directory (no leading /, ~ or -, no `..`, no glob or `$`). It
 *     only creates; on an existing directory it does nothing or fails.
 *   - `<tool> --version` or `<tool> --help`, alone, for a tool in
 *     VERSION_TOOLS, plus the short forms those tools define (`node -v`,
 *     `ffmpeg -version`). Any other bare command name (no path, no variable)
 *     may be probed with `--version` or `-v` alone (#4756), except `-v` on a
 *     shell, python or sudo. `--help`, `-h` and unknown flags stay limited to
 *     the known set: some system tools read them as an action (`shutdown -h`).
 * `bun run`, `node file.js` and any redirect into a file still go to the judge.
 *
 * `bun test` runs the repo's own test code, so it is behind its own option
 * and stays off unless the caller opts in. Callers pass the options; the env
 * flags are parsed in permissions/system-one-gate.ts so that turning System
 * One off still imports nothing from this package.
 *
 * Pure, synchronous, never throws. Prompt text only: nothing is executed.
 */

import { existsSync, lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activeShellKind } from "../core/shell";
import { type ActiveShellKind, posixRulesApply } from "../permissions/shell-tools";
import { promptControlText } from "./guard";
import { decideRules, maskQuotes, shellWords, splitSegments } from "./rules";

export type AllowlistVerdict = "pass-without-model" | "no-opinion";

export interface AllowlistOptions {
	/** Also pass `bun test` (it runs the repo's test code). Default false. */
	bunTest?: boolean;
	/** The shell that will parse the line. Default: the resolved shell on this machine. */
	shell?: ActiveShellKind;
}

export interface AllowlistResult {
	verdict: AllowlistVerdict;
	/** Why it passed, or why it had no opinion. */
	reason: string;
}

/** Binaries that only read, with no argument that writes, deletes or runs another program. */
export const READ_ONLY_BINS: ReadonlySet<string> = new Set([
	"ls",
	"pwd",
	"which",
	"wc",
	"head",
	"tail",
	"cat",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"echo",
	"printf",
	"true",
	"false",
	"sleep",
	"date",
	"file",
	"stat",
	"du",
	"df",
	"basename",
	"dirname",
	"realpath",
	"whoami",
	"uname",
	"tr",
	"cut",
	"diff",
	"cmp",
	"nl",
	"tree",
	"jq",
	"sort",
	"uniq",
	"find",
	"test",
]);

/** Arguments that make an otherwise read-only binary write, delete or run something. */
const WRITING_ARGS: Record<string, RegExp> = {
	find: /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/,
	sort: /^(-o|--output(=.*)?|-[a-zA-Z]*o)$/,
	tree: /^(-o|-[a-zA-Z]*o)$/,
	date: /^(-s|--set(=.*)?|-[a-zA-Z]*s)$/,
	rg: /^(--pre(=.*)?|--pre-glob(=.*)?)$/,
};

const GIT_READ = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "blame"]);
const GIT_BRANCH_READ = /^(-a|-r|-v|-vv|--all|--list|--remotes|--show-current|--no-color|--color)$/;
/** Git flags that write a file, run a helper or change config. */
const GIT_WRITING_ARG = /^(--output(=.*)?|-o|--ext-diff|-c|--exec-path(=.*)?|--config-env(=.*)?)$/;

/** Dev tools whose `--version` / `--help`, given alone, only print. */
export const VERSION_TOOLS: ReadonlySet<string> = new Set([
	"bun",
	"node",
	"npm",
	"npx",
	"pnpm",
	"yarn",
	"deno",
	"python",
	"python3",
	"pip",
	"pip3",
	"uv",
	"git",
	"go",
	"cargo",
	"rustc",
	"tsc",
	"gh",
	"docker",
	"make",
	"gcc",
	"clang",
	"java",
	"ruby",
	"perl",
	"php",
	"curl",
	"wget",
	"brew",
	"ffmpeg",
	"ffprobe",
	"marp",
	"jq",
	"rg",
	"sqlite3",
	"psql",
	"tmux",
	"biome",
	"eslint",
	"prettier",
	"vite",
]);
/** Short version flags, only for the tools that define them this way. */
const SHORT_VERSION: Record<string, string> = {
	node: "-v",
	bun: "-v",
	npm: "-v",
	pnpm: "-v",
	yarn: "-v",
	deno: "-V",
	python: "-V",
	python3: "-V",
	ffmpeg: "-version",
	ffprobe: "-version",
	go: "version",
};

/** A bare command name: letters, digits and . _ + - only. No path, no variable, no glob. */
const BARE_NAME = /^[A-Za-z][A-Za-z0-9._+-]*$/;
/** Tools whose `-v` is not a version flag: shells and REPLs read a script or stdin, sudo asks for a password. */
const NO_BARE_SHORT_V = new Set([
	"sh",
	"bash",
	"zsh",
	"dash",
	"fish",
	"ksh",
	"csh",
	"tcsh",
	"python",
	"python3",
	"sudo",
	"su",
	"doas",
]);

/**
 * A version probe: any bare command name with `--version` or `-v` as its only
 * argument (#4756: `pi --version` and `node --version` were refused on a phone,
 * and the fix is not to list every tool a person installs). VERSION_TOOLS keeps
 * its `--help` and per-tool short forms.
 */
function versionOnly(b: string, args: string[]): boolean {
	if (args.length !== 1) return false;
	if (VERSION_TOOLS.has(b)) {
		return args[0] === "--version" || args[0] === "--help" || SHORT_VERSION[b] === args[0];
	}
	if (!BARE_NAME.test(b)) return false;
	return args[0] === "--version" || (args[0] === "-v" && !NO_BARE_SHORT_V.has(b));
}

/** `mkdir` that only creates directories inside the working directory. */
function mkdirOk(args: string[]): string | null {
	const flags = args.filter((a) => a.startsWith("-"));
	const paths = args.filter((a) => !a.startsWith("-"));
	if (flags.some((f) => !["-p", "-v", "-pv", "-vp", "--parents", "--verbose"].includes(f)))
		return "mkdir with a flag other than -p/-v";
	if (paths.length === 0) return "mkdir with no path";
	for (const p of paths) {
		if (/^[/~]/.test(p) || /(^|\/)\.\.(\/|$)/.test(p) || /[*?[\]{}$]/.test(p))
			return `mkdir outside the working directory (${p})`;
	}
	return null;
}

const SECRET_ARG =
	/(^|\/)\.env(\.[\w.-]+)?$|(^|\/)\.env\b|id_rsa|id_ed25519|id_ecdsa|(^|\/)\.ssh(\/|$)|\.aws\/|credentials|\.netrc|\.npmrc|\.git-credentials|keychain|\.pem$|\.key$|\.p12$/;

/** Redirect in masked text: fd, operator, optional noclobber bar, target. */
const REDIR_RE = /(?<![<>&\d])(\d?|&)(>>?|<)(\|?)\s*(&\d+|[^\s;|&<>()]+)/g;
const OK_TARGET = /^(&\d|\/dev\/null$|\/tmp\/|\/private\/tmp\/)/;

const none = (reason: string): AllowlistResult => ({ verdict: "no-opinion", reason });

/**
 * `curl` GETs of this machine's own loopback address (#3714). Passes only when
 * every URL is http(s) on 127.0.0.1, localhost or [::1] (never the Ollama port),
 * every flag is on the list below, and output and cookie files are stdout,
 * /dev/null or /tmp. No -w/--write-out, upload, @file, proxy, config or
 * redirect-following; anything else goes to the judge. wget is not covered.
 * POST bodies are already escalated by the rules.
 */
const LOOPBACK_URL =
	/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?(?=[/?#]|$)[^\s[\]{}]*$/;
const OLLAMA_PORT = "11434";
const FETCH_FLAGS = {
	bare: "sSiIfv",
	valued: "ocbHmX",
	longBare: new Set([
		"--silent",
		"--show-error",
		"--include",
		"--head",
		"--fail",
		"--verbose",
		"--compressed",
	]),
	longValued: new Set([
		"--output",
		"--cookie-jar",
		"--cookie",
		"--header",
		"--max-time",
		"--connect-timeout",
	]),
};

function fetchTargetOk(v: string): boolean {
	return v === "-" || (OK_TARGET.test(v) && !/(^|\/)\.\.(\/|$)/.test(v));
}

function fetchValueOk(bin: string, flag: string, v: string): string | null {
	const f = flag.replace(/^-+/, "");
	if (f === "o" || f === "output" || f === "c" || f === "cookie-jar")
		return fetchTargetOk(v) ? null : `${bin} writes to ${v}`;
	if (f === "b" || f === "cookie")
		return v.includes("=") || fetchTargetOk(v) ? null : `${bin} reads cookies from ${v}`;
	if (f === "H" || f === "header") return v.startsWith("@") ? `${bin} reads ${v}` : null;
	if (f === "m" || f === "max-time" || f === "connect-timeout")
		return /^\d{1,3}$/.test(v) ? null : `${bin} timeout is not a number`;
	if (f === "X") return v === "GET" || v === "HEAD" ? null : `${bin} -X ${v}`;
	return `${bin} flag ${flag}`;
}

/** Proxy variables curl honours; any of them would send a loopback request (and its body) elsewhere. */
const CURL_PROXY_ENV = /^(http|https|all)_proxy$/i;

/**
 * Why a curl cannot be trusted to stay on this machine because of its
 * ENVIRONMENT, or null: a proxy variable (any case) is set, or a curlrc exists
 * in $CURL_HOME, $XDG_CONFIG_HOME, ~ or ~/.config and `-q` is not the first
 * argument. Shared with packages/permissions/s1-curl-loopback.ts.
 */
export function curlEnvRefusal(
	qFirst: boolean,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	for (const [k, v] of Object.entries(env))
		if (v && CURL_PROXY_ENV.test(k)) return `curl with ${k} set`;
	if (qFirst) return null;
	const dirs = new Set<string>();
	for (const e of [env.CURL_HOME, env.XDG_CONFIG_HOME, env.HOME, homedir()]) if (e) dirs.add(e);
	for (const d of dirs) {
		for (const f of [join(d, ".curlrc"), join(d, "_curlrc"), join(d, ".config", "curlrc")]) {
			if (existsSync(f)) return "curl with a curlrc present and no -q first";
		}
	}
	return null;
}

function loopbackFetchOk(bin: string, argsIn: string[]): string | null {
	const qFirst = bin === "curl" && (argsIn[0] === "-q" || argsIn[0] === "--disable");
	const args = qFirst ? argsIn.slice(1) : argsIn;
	if (bin === "curl") {
		const env = curlEnvRefusal(qFirst);
		if (env) return env;
	}
	const spec = FETCH_FLAGS;
	const urls: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a.startsWith("--")) {
			if (spec.longBare.has(a)) continue;
			if (!spec.longValued.has(a) || i + 1 >= args.length)
				return `${bin} with ${a}, not a loopback-GET flag`;
			const why = fetchValueOk(bin, a, args[++i]);
			if (why) return why;
		} else if (a.length > 1 && a.startsWith("-")) {
			for (let j = 1; j < a.length; j++) {
				const ch = a[j];
				if (spec.bare.includes(ch)) continue;
				if (!spec.valued.includes(ch)) return `${bin} with -${ch}, not a loopback-GET flag`;
				const v = j + 1 < a.length ? a.slice(j + 1) : args[++i];
				if (v === undefined) return `${bin} -${ch} has no value`;
				const why = fetchValueOk(bin, `-${ch}`, v);
				if (why) return why;
				break;
			}
		} else urls.push(a);
	}
	if (urls.length === 0) return `${bin} with no URL`;
	for (const u of urls) {
		const m = LOOPBACK_URL.exec(u);
		if (!m) return `${bin} reaches ${u}, not the loopback address`;
		if (m[1] === OLLAMA_PORT) return `${bin} reaches the Ollama port`;
	}
	return null;
}

function segmentOk(text: string, opts: AllowlistOptions): string | null {
	const masked = maskQuotes(text);
	let stripped = "";
	let last = 0;
	for (const m of masked.matchAll(REDIR_RE)) {
		const start = (m.index ?? 0) + m[0].length - m[4].length;
		const target = text.slice(start, start + m[4].length).replace(/^['"]+|['"]+$/g, "");
		const op = m[2];
		if (op === "<") {
			if (SECRET_ARG.test(target)) return `reads a secret (${target})`;
		} else if (!OK_TARGET.test(target)) return `writes to ${target}`;
		stripped += text.slice(last, m.index);
		last = (m.index ?? 0) + m[0].length;
	}
	stripped += text.slice(last);
	if (/[<>]/.test(maskQuotes(stripped))) return "has a redirect it cannot read";
	const words = shellWords(stripped);
	if (!words) return "cannot be tokenised";
	if (words.length === 0) return text.trim() === "" ? null : "is a bare redirect";
	const [b, ...args] = words;
	if (b.includes("=") || b.includes("/")) return `runs ${b}, not a bare read-only binary`;
	if (args.some((a) => SECRET_ARG.test(a))) return "names a secret";
	if (b === "cd") return null;
	if (versionOnly(b, args)) return null;
	if (b === "mkdir") return mkdirOk(args);
	if (b === "curl") return loopbackFetchOk(b, args);
	if (b === "git") return gitOk(args);
	if (b === "bun") {
		if (args[0] !== "test") return "runs bun, not bun test";
		return opts.bunTest ? null : "bun test is not enabled (EIGHT_S1_ALLOWLIST_BUN_TEST)";
	}
	if (!READ_ONLY_BINS.has(b)) return `${b} is not on the read-only list`;
	const bad = WRITING_ARGS[b];
	if (bad && args.some((a) => bad.test(a))) return `${b} with an argument that writes or runs`;
	if (b === "uniq" && args.filter((a) => !a.startsWith("-")).length > 1)
		return "uniq with an output file";
	return null;
}

/**
 * `--git-dir` turns off git's safe.directory ownership check, so it could read config
 * (and run its hooks or helpers) from a repo another user owns; `-C` keeps the check.
 * We cannot know the directory git will run in (session workdir, `cd X &&`, option order),
 * so only an absolute value is judged: it must start with "/", hold no "~" (the shell
 * expands it) and no "." or ".." segment (the kernel follows links before `..`), and then
 * be stat'd as written. It must be a directory (a gitfile redirects git unchecked) with no
 * `commondir` file and no symlinked `config` (both redirect config, unchecked, to another
 * repo; linked-worktree gitdirs therefore go to the judge). No getuid (Windows) means false.
 */
function gitDirOwnedByMe(value: string | undefined): boolean {
	if (!value || typeof process.getuid !== "function") return false;
	if (!value.startsWith("/") || value.includes("~")) return false;
	if (value.split("/").some((seg) => seg === "." || seg === "..")) return false;
	try {
		const st = statSync(value);
		if (!st.isDirectory() || st.uid !== process.getuid()) return false;
	} catch {
		return false;
	}
	try {
		lstatSync(join(value, "commondir"));
		return false;
	} catch {
		// no commondir: fine
	}
	try {
		const c = lstatSync(join(value, "config"));
		// a symlinked or foreign-owned config is read without an ownership check
		if (!c.isFile() || c.uid !== process.getuid()) return false;
	} catch {
		// no config: fine
	}
	return true;
}

function gitOk(args: string[]): string | null {
	// The shell expands braces and globs before git sees them, so the words we read are not the words git gets.
	if (args.some((a) => /[*?[\]{}]/.test(a))) return "git with a glob or brace the shell expands";
	let i = 0;
	// Global options skipped before the subcommand: -C <p>, --git-dir[=]<p>, --work-tree[=]<p>, --no-pager (#4299).
	// A value taken by a spaced option is consumed, so `--git-dir push` never reads `push` as the subcommand.
	while (i < args.length) {
		const a = args[i];
		if (a === "--no-pager" || a.startsWith("--work-tree=")) i += 1;
		else if (a.startsWith("--git-dir=")) {
			if (!gitDirOwnedByMe(a.slice(10))) return "git --git-dir is not a path owned by this user";
			i += 1;
		} else if (a === "--git-dir") {
			if (!gitDirOwnedByMe(args[i + 1])) return "git --git-dir is not a path owned by this user";
			i += 2;
		} else if (a === "-C") {
			i += 2;
		} else if (a === "--work-tree") i += 2;
		else break;
	}
	const sub = args[i];
	const rest = args.slice(i + 1);
	if (args.some((a) => GIT_WRITING_ARG.test(a))) return "git with an argument that writes or runs";
	if (sub && GIT_READ.has(sub)) return null;
	if (sub === "branch" && rest.every((a) => GIT_BRANCH_READ.test(a))) return null;
	if (sub === "remote" && rest.every((a) => a === "-v" || a === "--verbose")) return null;
	return `git ${sub ?? ""} is not a read-only git subcommand`.trim();
}

/**
 * True when a `$` other than `$?` sits inside double quotes, unescaped (#3315).
 * The shell still expands it there, so the allowlist cannot see the argument
 * (`cat "$F"` may name a key file). A `$` in single quotes stays literal.
 */
function dollarInDoubleQuotes(s: string): boolean {
	let q: string | null = null;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (q === "'") {
			if (ch === "'") q = null;
		} else if (ch === "\\") {
			i++; // the next character is literal, in or out of double quotes
		} else if (q === '"') {
			if (ch === '"') q = null;
			else if (ch === "$" && s[i + 1] !== "?") return true;
		} else if (ch === "'" || ch === '"') q = ch;
	}
	return false;
}

/** Decide whether a command may run without asking the model. Never throws. */
export function readOnlyAllowlist(command: string, opts: AllowlistOptions = {}): AllowlistResult {
	try {
		if (!command.trim()) return none("empty command");
		if (!posixRulesApply(command, opts.shell ?? activeShellKind()))
			return none("the shell does not parse this line the POSIX way");
		if (promptControlText(command) !== null) return none("carries prompt-control text");
		const rules = decideRules(command);
		if (rules.verdict !== "pass")
			return none(`rule ${rules.rule} fired (${rules.verdict}); rules win`);
		if (/\$\(|`|<\(|>\(|<<|\$\[/.test(command)) return none("has a substitution or heredoc");
		if (/\$(?!\?)/.test(maskQuotes(command))) return none("has an unquoted $ expansion");
		if (dollarInDoubleQuotes(command)) return none("has a $ expansion inside double quotes");
		const { segs, subs } = splitSegments(command);
		if (subs.length) return none("has a substitution");
		for (const { text } of segs) {
			const why = segmentOk(text, opts);
			if (why) return none(why);
		}
		return {
			verdict: "pass-without-model",
			reason: opts.bunTest ? "read-only or bun test" : "read-only",
		};
	} catch {
		return none("allowlist parse error");
	}
}
