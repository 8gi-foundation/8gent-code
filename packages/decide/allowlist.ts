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
 *     `ffmpeg -version`). A known set, never "any binary": some system tools
 *     read -h or an unknown flag as an action (`shutdown -h`).
 * `bun run`, `node file.js` and any redirect into a file still go to the judge.
 *
 * Index-only git (#3298): `git rm --cached` only untracks and leaves the
 * files on disk; plain `git rm` deletes from the working tree. git honours
 * `--no-cached` anywhere before `--`, so any word this parser reads
 * differently from the shell would defeat a parsed check (review of #3299
 * found six: mid-word `#`, braces, globs, `>&2--cached`, backslash-newline,
 * CR). So it is deny-by-default on the RAW command text, never on parsed
 * words: the whole command is `git rm` and nothing else, every character is
 * in [A-Za-z0-9 ._/@+=,:%-] (plain spaces only), flags come only from
 * `--cached` (exactly once), `-r`, `-q`, `--quiet`, `-n`, `--dry-run`,
 * `--ignore-unmatch`, `-f`, `--force`, then an optional `--`, then one or
 * more paths. Before `--` no path may start with `-`.
 *
 * `bun test` runs the repo's own test code, so it is behind its own option
 * and stays off unless the caller opts in. Callers pass the options; the env
 * flags are parsed in permissions/system-one-gate.ts so that turning System
 * One off still imports nothing from this package.
 *
 * Pure, synchronous, never throws. Prompt text only: nothing is executed.
 */

import { promptControlText } from "./guard";
import { decideRules, maskQuotes, shellWords, splitSegments } from "./rules";

export type AllowlistVerdict = "pass-without-model" | "no-opinion";

export interface AllowlistOptions {
	/** Also pass `bun test` (it runs the repo's test code). Default false. */
	bunTest?: boolean;
}

export interface AllowlistResult {
	verdict: AllowlistVerdict;
	/** Why it passed, or why it had no opinion. */
	reason: string;
}

/** Binaries that only read, with no argument that writes, deletes or runs another program. */
export const READ_ONLY_BINS: ReadonlySet<string> = new Set([
	"ls", "pwd", "which", "wc", "head", "tail", "cat", "grep", "egrep", "fgrep", "rg", "echo", "printf", "true", "false",
	"sleep", "date", "file", "stat", "du", "df", "basename", "dirname", "realpath", "whoami", "uname", "tr", "cut", "diff",
	"cmp", "nl", "tree", "jq", "sort", "uniq", "find", "test",
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
	"bun", "node", "npm", "npx", "pnpm", "yarn", "deno", "python", "python3", "pip", "pip3", "uv", "git", "go", "cargo",
	"rustc", "tsc", "gh", "docker", "make", "gcc", "clang", "java", "ruby", "perl", "php", "curl", "wget", "brew",
	"ffmpeg", "ffprobe", "marp", "jq", "rg", "sqlite3", "psql", "tmux", "biome", "eslint", "prettier", "vite",
]);
/** Short version flags, only for the tools that define them this way. */
const SHORT_VERSION: Record<string, string> = {
	node: "-v", bun: "-v", npm: "-v", pnpm: "-v", yarn: "-v", deno: "-V", python: "-V", python3: "-V",
	ffmpeg: "-version", ffprobe: "-version", go: "version",
};

function versionOnly(b: string, args: string[]): boolean {
	if (!VERSION_TOOLS.has(b) || args.length !== 1) return false;
	return args[0] === "--version" || args[0] === "--help" || SHORT_VERSION[b] === args[0];
}

/** `mkdir` that only creates directories inside the working directory. */
function mkdirOk(args: string[]): string | null {
	const flags = args.filter((a) => a.startsWith("-"));
	const paths = args.filter((a) => !a.startsWith("-"));
	if (flags.some((f) => !["-p", "-v", "-pv", "-vp", "--parents", "--verbose"].includes(f))) return "mkdir with a flag other than -p/-v";
	if (paths.length === 0) return "mkdir with no path";
	for (const p of paths) {
		if (/^[/~]/.test(p) || /(^|\/)\.\.(\/|$)/.test(p) || /[*?[\]{}$]/.test(p)) return `mkdir outside the working directory (${p})`;
	}
	return null;
}

const SECRET_ARG =
	/(^|\/)\.env(\.[\w.-]+)?$|(^|\/)\.env\b|id_rsa|id_ed25519|id_ecdsa|(^|\/)\.ssh(\/|$)|\.aws\/|credentials|\.netrc|\.npmrc|\.git-credentials|keychain|\.pem$|\.key$|\.p12$/;

/** Redirect in masked text: fd, operator, optional noclobber bar, target. */
const REDIR_RE = /(?<![<>&\d])(\d?|&)(>>?|<)(\|?)\s*(&\d+|[^\s;|&<>()]+)/g;
const OK_TARGET = /^(&\d|\/dev\/null$|\/tmp\/|\/private\/tmp\/)/;

const none = (reason: string): AllowlistResult => ({ verdict: "no-opinion", reason });

function segmentOk(text: string, opts: AllowlistOptions, whole: string): string | null {
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
	if (b === "git") return gitOk(args, whole);
	if (b === "bun") {
		if (args[0] !== "test") return "runs bun, not bun test";
		return opts.bunTest ? null : "bun test is not enabled (EIGHT_S1_ALLOWLIST_BUN_TEST)";
	}
	if (!READ_ONLY_BINS.has(b)) return `${b} is not on the read-only list`;
	const bad = WRITING_ARGS[b];
	if (bad && args.some((a) => bad.test(a))) return `${b} with an argument that writes or runs`;
	if (b === "uniq" && args.filter((a) => !a.startsWith("-")).length > 1) return "uniq with an output file";
	return null;
}

/** Characters the raw `git rm --cached` command may contain. No quoting, expansion, redirect or separator. */
const GIT_RM_RAW = /^[A-Za-z0-9 ._/@+=,:%-]+$/;
/** Flags `git rm --cached` may carry, exact spellings only (no clusters, no abbreviations). */
const GIT_RM_CACHED_FLAGS: ReadonlySet<string> = new Set([
	"--cached",
	"-r",
	"-q",
	"--quiet",
	"-n",
	"--dry-run",
	"--ignore-unmatch",
	"-f",
	"--force",
]);

/**
 * `git rm --cached <path>...` only removes paths from the index (#3298).
 * Decided on the raw command text, tokenised here on spaces, never through
 * shellWords: anything the shell could read differently is no-opinion.
 *
 * Why each restriction exists. git honours `--no-cached` anywhere before
 * `--`, so one word the shell sees differently turns this into plain
 * `git rm`, which deletes the file. Each of these was shown to delete a
 * tracked file under a real shell in review of #3299:
 *   - mid-word `#`, braces, globs: the parser and sh disagree on the words;
 *   - `>&2--cached`: a redirect the parser split into a separate flag;
 *   - backslash-newline, CR, TAB: whitespace the parser and sh treat apart.
 * GIT_RM_RAW therefore admits only plain spaces and characters with no
 * meaning to any shell. `git` and `rm` must be the first two words (no
 * global options, which could shift the subcommand), `--cached` must appear
 * exactly once, flags come before paths, and only `--` may end the flags.
 */
function gitRmCachedOk(raw: string): string | null {
	if (!GIT_RM_RAW.test(raw)) return "git rm with a character outside the plain set";
	const words = raw.split(" ").filter((w) => w !== "");
	if (words[0] !== "git" || words[1] !== "rm") return "git rm must be the whole command";
	let cached = 0;
	let i = 2;
	for (; i < words.length && words[i] !== "--" && words[i].startsWith("-"); i++) {
		if (!GIT_RM_CACHED_FLAGS.has(words[i])) return `git rm with ${words[i]}`;
		if (words[i] === "--cached") cached++;
	}
	if (cached !== 1) return cached === 0 ? "git rm without --cached deletes files from disk" : "git rm with --cached twice";
	const afterDashDash = words[i] === "--";
	const paths = words.slice(afterDashDash ? i + 1 : i);
	if (paths.length === 0) return "git rm --cached with no path";
	if (!afterDashDash && paths.some((p) => p.startsWith("-"))) return "git rm with a flag after a path";
	return null;
}

function gitOk(args: string[], whole: string): string | null {
	let i = 0;
	while (i < args.length && (args[i] === "--no-pager" || args[i] === "-C")) i += args[i] === "-C" ? 2 : 1;
	const sub = args[i];
	const rest = args.slice(i + 1);
	if (args.some((a) => GIT_WRITING_ARG.test(a))) return "git with an argument that writes or runs";
	if (sub && GIT_READ.has(sub)) return null;
	if (sub === "branch" && rest.every((a) => GIT_BRANCH_READ.test(a))) return null;
	if (sub === "remote" && rest.every((a) => a === "-v" || a === "--verbose")) return null;
	if (sub === "rm") return gitRmCachedOk(whole);
	return `git ${sub ?? ""} is not a read-only git subcommand`.trim();
}

/** Decide whether a command may run without asking the model. Never throws. */
export function readOnlyAllowlist(command: string, opts: AllowlistOptions = {}): AllowlistResult {
	try {
		if (!command.trim()) return none("empty command");
		if (promptControlText(command) !== null) return none("carries prompt-control text");
		const rules = decideRules(command);
		if (rules.verdict !== "pass") return none(`rule ${rules.rule} fired (${rules.verdict}); rules win`);
		if (/\$\(|`|<\(|>\(|<<|\$\[/.test(command)) return none("has a substitution or heredoc");
		if (/\$(?!\?)/.test(maskQuotes(command))) return none("has an unquoted $ expansion");
		const { segs, subs } = splitSegments(command);
		if (subs.length) return none("has a substitution");
		for (const { text } of segs) {
			const why = segmentOk(text, opts, command);
			if (why) return none(why);
		}
		return { verdict: "pass-without-model", reason: opts.bunTest ? "read-only or bun test" : "read-only" };
	} catch {
		return none("allowlist parse error");
	}
}
