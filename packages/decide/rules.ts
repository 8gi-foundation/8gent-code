/**
 * Deterministic rule pre-filter for the bash guard.
 *
 * A TypeScript rebuild of the destructive rules used to label the mined
 * corpus (a private labeller on James's machine; no mined command is in this
 * repo). The command is parsed as TEXT ONLY and never executed:
 *
 *   1. Heredoc bodies are cut out. A body fed to a shell or ssh is analysed as
 *      shell; fed to an interpreter it is scanned as code; fed to a DB client
 *      as SQL; fed to cat/tee it is file content and only the redirect counts.
 *   2. The rest is split into segments on unquoted ; && || | & and newlines.
 *      $(...), <(...), >(...) and backtick bodies are analysed as more shell.
 *   3. Each segment: env assignments and wrappers (sudo, env, nohup, time,
 *      timeout, nice, xargs, command, exec ...) are stripped, bash -c / sh -c /
 *      eval / watch / ssh host '<cmd>' / find -exec are recursed into, then
 *      the binary's rules apply.
 *   4. Whole-command rules: remote code piped or substituted into a shell, and
 *      a secret read in the same command as a network sender. These look at
 *      the command with quoted string CONTENT masked (so a commit message that
 *      mentions a pipe to a shell does not fire), except that $(...) and
 *      backticks inside double quotes still run and are kept.
 *
 * Verdicts:
 *   block    - a rule in BLOCK_RULES matched: catastrophic and never part of a
 *              normal agent workflow. The model is not asked.
 *   escalate - some other destructive rule matched. The model is still asked
 *              and may raise it to block; it can never lower it to allow.
 *   pass     - no rule matched. This means "ask the model", NEVER "allow".
 *
 * INVARIANT: rules only make the guard stricter. There is no allow path here.
 */

import { homedir } from "node:os";

export type RuleVerdict = "block" | "escalate" | "pass";

export interface RuleResult {
	verdict: RuleVerdict;
	/** The deciding rule: the first block rule, else the first rule that fired. */
	rule?: string;
	/** Every destructive rule that fired, in order, deduplicated. */
	rules: string[];
}

/**
 * Rules that block outright. Everything else that fires escalates. A rule is
 * here only when no ordinary agent task needs it without a human doing it by
 * hand: wiping a disk or the home directory, running remote code, sending a
 * secret over the network, loosening permissions on a system path.
 */
export const BLOCK_RULES: ReadonlySet<string> = new Set([
	"disk_format_or_wipe",
	"diskutil_erase",
	"remote_code_piped_to_shell",
	"remote_code_piped_to_interpreter",
	"remote_code_substituted_into_shell",
	"secret_to_network",
	"chmod_system_path",
	"chown_system_path",
	"chgrp_system_path",
	"chflags_system_path",
	"truncate_sensitive_file",
	"kill_all_or_launchd",
	"kill_system_process",
	"keychain_delete",
	"csrutil_disable_or_clear",
	"spctl_disable_or_clear",
	"nvram_disable_or_clear",
]);

// ------------------------------------------------------------------ patterns

const TEMP_RE =
	/^(\/tmp\b|\/private\/tmp\b|\/var\/folders\b|\/private\/var\/folders\b|\$\{?TMPDIR\}?|\$\{?TMP\}?\b|\$\{?SCRATCH|\/dev\/null$|\/dev\/stdout$|\/dev\/stderr$|\/dev\/tty$)/;
const SYSTEM_PATH_RE =
	/^(\/|\/\*|\/usr(\/.*)?|\/etc(\/.*)?|\/System(\/.*)?|\/Library(\/.*)?|\/bin(\/.*)?|\/sbin(\/.*)?|\/opt|\/opt\/homebrew|\/var|\/private|\/private\/etc(\/.*)?|\/Applications|\/Users|~|~\/|~\/\*|\$HOME\/?|\$\{HOME\}\/?)$/;
/** A home directory or a top-level folder in it (~/Documents, $HOME/Desktop, /Users/x). */
const HOME_TOP_RE = /^((~|\$HOME|\$\{HOME\})\/[^/]+\/?|\/Users\/[^/]+\/?(\*)?)$/;
const SENSITIVE_FILE_RE =
	/(^|\/)(\.zshrc|\.bashrc|\.bash_profile|\.zprofile|\.profile|\.gitconfig|\.npmrc|\.netrc|authorized_keys|known_hosts|id_rsa|id_ed25519|config\.toml|settings\.json|\.env(\.[\w.-]+)?|hosts|sudoers|passwd|crontab)$|^\/etc\/|^~\/\.ssh\/|^\/dev\/(disk|rdisk|sd)/;
/**
 * Project manifests, lockfiles and build config. Truncating one (`>`, `>|`,
 * `tee` without -a, `cp /dev/null`) escalates (overwrite_project_manifest):
 * writing a whole new one is sometimes a real scaffold step, so a human
 * confirms it rather than the guard blocking it. Matches the basename exactly,
 * so package.json.bak does not fire.
 */
const MANIFEST_RE =
	/(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|tsconfig(\.[\w-]+)?\.json|jsconfig\.json|deno\.jsonc?|Cargo\.(toml|lock)|go\.(mod|sum)|pyproject\.toml|setup\.(py|cfg)|requirements[\w.-]*\.txt|Pipfile(\.lock)?|poetry\.lock|uv\.lock|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?|Makefile|CMakeLists\.txt|Dockerfile|docker-compose[\w.-]*\.ya?ml|compose\.ya?ml|\.gitignore|\.gitattributes|\.gitmodules|\.github\/workflows\/[^/]+\.ya?ml)$/;
/**
 * Dotfiles SENSITIVE_FILE_RE does not list. Truncating one escalates
 * (truncate_dotfile); the SENSITIVE_FILE_RE set keeps its block.
 */
const DOTFILE_EXTRA_RE = /(^|\/)(\.zshenv|\.zlogin|\.bash_login|\.bash_logout|\.inputrc|\.vimrc|\.tmux\.conf|\.ssh\/config)$/;
const NET_SINK =
	/(?:^|[\s|;&(])(?:curl\b[^|;&\n]*(?:\s-d\b|\s--data|\s-F\b|\s--form|\s-T\b|\s--upload-file|\s-X\s*(?:POST|PUT|PATCH))|nc\b|ncat\b|netcat\b|scp\b|sftp\b|ftp\b|telnet\b|wget\b[^|;&\n]*--post|rsync\b[^|;&\n]*\S+:\S*)/;
const SECRET_READ = new RegExp(
	[
		String.raw`(?:(?:cat|less|head|tail|base64|xxd|od|strings|tar|zip|gpg)\s+[^|;&\n]*(?:\.env\b|\.ssh/id_\w+(?!\.pub)|id_rsa(?!\.pub)|id_ed25519(?!\.pub)|\.aws/credentials|\.netrc|\.git-credentials|\.npmrc|keychain-db))`,
		String.raw`(?:^|[|;&\s(])(?:env|printenv|set)\s*(?:\||>)`,
		String.raw`@[^\s"']*(?:\.env\b|\.ssh/|id_rsa|id_ed25519|credentials|\.netrc)`,
		String.raw`(?:scp|rsync|sftp)\s+(?:-\w+\s+(?:\S+\s+)?)*[^\s|;&]*(?:\.env\b|\.ssh/id_\w+(?!\.pub)|id_rsa(?!\.pub)|\.aws/credentials)\S*\s+\S+:`,
		String.raw`security\s+find-(?:generic|internet)-password[^|;&\n]*-w[^\n]*\|\s*(?:curl|nc|ssh)`,
	].join("|"),
);
const REMOTE_EXEC_RE = /(?:ba|z|da|k)?sh\s+(?:-\w+\s+)*["']?\$\((?:curl|wget)\b|<\((?:curl|wget)\b|\beval\s+["']?\$\((?:curl|wget)\b/;

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const INTERPRETERS = new Set([
	"python", "python3", "python3.11", "python3.12", "python3.13", "node", "bun", "deno", "ruby", "perl", "php", "osascript", "tsx", "ts-node",
]);
const DB_CLIENTS = new Set(["psql", "sqlite3", "mysql", "mongosh", "mongo", "redis-cli", "duckdb", "clickhouse-client"]);
const WRAPPERS = new Set([
	"sudo", "nohup", "time", "command", "builtin", "exec", "stdbuf", "unbuffer", "caffeinate", "nice", "timeout", "gtimeout", "env", "doas", "arch", "noglob", "!",
]);
const CONTROL = new Set([
	"if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "case", "esac", "in", "{", "}", "(", ")", "function", "select", "[[", "]]", "!", "coproc",
]);
const DESTRUCTIVE_ALWAYS = new Set(["mkfs", "newfs_apfs", "newfs_hfs", "newfs_msdos", "fdisk", "gpt", "shred", "srm", "wipefs", "sgdisk", "parted"]);
const CLOUD_BINS = new Set([
	"aws", "gcloud", "gsutil", "az", "kubectl", "helm", "terraform", "tofu", "pulumi", "heroku", "railway", "netlify", "supabase", "doctl", "stripe", "firebase",
	"hcloud", "linode-cli", "oci", "render", "neonctl", "turso", "planetscale", "pscale", "upstash", "cloudflared",
]);
const NET_FETCHERS = new Set(["curl", "wget", "http"]);

const CODE_DELETE =
	/shutil\.rmtree|os\.remove\(|os\.unlink\(|os\.rmdir\(|\.unlink\(|rmSync|unlinkSync|rmdirSync|fs\.rm\(|fs\.promises\.rm\b|fsp?\.rm\(|\brm\s+-[a-zA-Z]*[rf]|DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM|File\.delete|FileUtils\.rm|\.drop\(\)|dropDatabase/i;
const SQL_DESTRUCTIVE = /\b(DROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW|COLLECTION)|TRUNCATE\b|DELETE\s+FROM|FLUSHALL|FLUSHDB|dropDatabase|\.drop\(\)|deleteMany|\bDEL\s+\w)/i;
const GH_DELETE = /^(repo|release|issue|label|secret|variable|run|cache|gist|ssh-key|gpg-key|project|codespace|ruleset|extension)$/;
const MAX_DEPTH = 6;

// ------------------------------------------------------------------ result

class Collector {
	readonly fired: { rule: string; block: boolean }[] = [];
	/** A secret was read somewhere in the command (any nesting level). */
	secretRead = false;
	/** A network sender appears somewhere in the command (any nesting level). */
	netSink = false;
	/**
	 * Same-line `NAME=value` / `export NAME=value` assignments seen so far
	 * (#3314). null = assigned something this text cannot resolve.
	 */
	readonly vars = new Map<string, string | null>();
	/** The working directory is home or a system path (from the caller, or a `cd` on this line). */
	cwdDanger = false;
	d(rule: string, block = BLOCK_RULES.has(rule)): void {
		this.fired.push({ rule, block });
	}
}

// ------------------------------------------------------------------ variables (#3314)

/** `$NAME`, `${NAME}`, `${NAME<op>word}` (one level of nested braces in word), `$0`..`$9`, `$@`, `$*`. */
const VAR_REF_RE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*|[0-9@*])(?:(:?[-=?+])((?:[^{}]|\{[^{}]*\})*))?\}|([A-Za-z_][A-Za-z0-9_]*|[0-9@*]))/;
const MAX_CANDIDATES = 64;
/** A target that names the working directory itself or everything in it: `.`, `*`, `./*`, `.*`. */
const CWD_TARGET_RE = /^(\.\/)*(\.|\*|\.\*)?\/?$/;
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
const DECLARERS = new Set(["export", "declare", "typeset", "local", "readonly"]);

/**
 * Every text a path argument could expand to, judged statically and failing
 * closed. A variable assigned earlier on the line takes its value; `$HOME`
 * always stays `$HOME` too (a reassigned HOME never loosens a match); any
 * other variable stays as `$NAME` AND may be empty, unless `${NAME:?}`
 * forbids the empty case. `${A:-w}` and `${A:=w}` may be either side;
 * `${A:+w}` is empty or w. Only the text after a reference is re-scanned, so
 * a `$NAME` placeholder is never expanded twice.
 */
function expandCandidates(p: string, vars: ReadonlyMap<string, string | null>, depth = 0): string[] {
	const m = VAR_REF_RE.exec(p);
	if (!m || depth > 8) return [p];
	const name = m[1] ?? m[4];
	const op = m[2] ?? "";
	const word = m[3] ?? "";
	const prefix = p.slice(0, m.index);
	const suffix = p.slice(m.index + m[0].length);
	const known = vars.get(name);
	let values: string[];
	if (name === "HOME") values = ["$HOME", ...(typeof known === "string" ? expandCandidates(known, vars, depth + 1) : [])];
	else if (typeof known === "string") values = expandCandidates(known, vars, depth + 1);
	else values = [`$${name}`, ""];
	if (op === ":-" || op === "-" || op === ":=" || op === "=") values = [...values, ...expandCandidates(word, vars, depth + 1)];
	else if (op === ":+" || op === "+") values = ["", ...expandCandidates(word, vars, depth + 1)];
	else if (op === ":?") values = values.filter((v) => v !== "");
	const out = new Set<string>();
	const rest = expandCandidates(suffix, vars, depth + 1);
	for (const v of values) {
		for (const s of rest) {
			out.add(prefix + v + s);
			if (out.size >= MAX_CANDIDATES) return [...out];
		}
	}
	return [...out];
}

/** Home, a home top-level folder, or a system path. */
function dangerousDir(d: string): boolean {
	const t = d.length > 1 ? d.replace(/\/+$/, "") : d;
	return SYSTEM_PATH_RE.test(t) || HOME_TOP_RE.test(t) || t === homedir().replace(/\/+$/, "");
}

/** Record same-line assignments and `cd` targets, after the segment itself is analysed. */
function trackShellState(tIn: string[], r: Collector): void {
	let t = tIn;
	while (t.length && CONTROL.has(t[0])) t = t.slice(1);
	if (!t.length) return;
	const declared = DECLARERS.has(t[0]);
	const words = declared ? t.slice(1).filter((w) => !w.startsWith("-")) : t;
	// `D=x` alone sets D. `D=x cmd` is a prefix assignment: the expansion in
	// cmd never sees it, so it records nothing and $D stays unknown.
	if (declared || words.every((w) => ASSIGN_RE.test(w))) {
		for (const w of words) {
			const a = ASSIGN_RE.exec(w);
			if (a) r.vars.set(a[1], /\$\(|`|<\(/.test(a[2]) ? null : a[2]);
		}
		return;
	}
	const s = stripWrappers(t);
	if (s[0] !== "cd" && s[0] !== "pushd") return;
	const target = positional(s.slice(1))[0];
	if (target === undefined) {
		r.cwdDanger = true; // a bare cd goes home
		return;
	}
	if (!/^[/~$]/.test(target)) return; // relative or `cd -`: keep the state (below home is still home's top level)
	const cands = expandCandidates(target, r.vars);
	if (cands.some(dangerousDir)) r.cwdDanger = true;
	else if (cands.every((c) => c.startsWith("/") && !c.includes("$"))) r.cwdDanger = false;
	// Anything else could not be resolved: keep the state (fail closed).
}

// ------------------------------------------------------------------ helpers

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const isTemp = (p: string) => TEMP_RE.test(p) || /\/claude-\d+\//.test(p) || p.includes("/scratchpad");
const positional = (args: string[]) => args.filter((a) => !a.startsWith("-"));

function hasFlag(args: string[], short: string | null, long: readonly string[] = []): boolean {
	for (const a of args) {
		if (a.startsWith("--")) {
			if (long.includes(a.split("=")[0])) return true;
		} else if (a.startsWith("-") && short && a.length > 1 && !/\d/.test(a[1])) {
			for (const c of a.slice(1)) if (short.includes(c)) return true;
		}
	}
	return false;
}

/** Replace every character inside quotes (and each escaped character) with "_", same length. */
export function maskQuotes(s: string): string {
	let out = "";
	let q: string | null = null;
	let esc = false;
	for (const ch of s) {
		if (esc) {
			out += "_";
			esc = false;
		} else if (ch === "\\" && q !== "'") {
			out += "_";
			esc = true;
		} else if (q) {
			if (ch === q) {
				q = null;
				out += ch;
			} else out += "_";
		} else {
			if (ch === "'" || ch === '"') q = ch;
			out += ch;
		}
	}
	return out;
}

/**
 * Mask quoted string content like `maskQuotes`, but keep $(...) and backtick
 * bodies inside double quotes, because the shell runs those. Used by the
 * whole-command rules so a quoted argument (a commit message, an echo) cannot
 * trigger them while `bash -c "$(curl ...)"` still does.
 */
export function maskData(s: string): string {
	let out = "";
	let q: string | null = null;
	let depth = 0;
	let tick = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (q === "'") {
			if (ch === "'") {
				q = null;
				out += ch;
			} else out += "_";
			continue;
		}
		if (q === '"') {
			if (depth === 0 && !tick) {
				if (ch === "\\") {
					out += "__";
					i++;
				} else if (ch === '"') {
					q = null;
					out += ch;
				} else if (ch === "$" && s[i + 1] === "(") {
					depth = 1;
					out += "$(";
					i++;
				} else if (ch === "`") {
					tick = true;
					out += ch;
				} else out += "_";
			} else {
				out += ch;
				if (tick && ch === "`") tick = false;
				else if (depth > 0 && ch === "(") depth++;
				else if (depth > 0 && ch === ")") depth--;
			}
			continue;
		}
		if (ch === "\\") {
			out += s.slice(i, i + 2);
			i++;
		} else {
			if (ch === "'" || ch === '"') q = ch;
			out += ch;
		}
	}
	return out;
}

const HEREDOC_RE = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;
const HEREDOC_AT = new RegExp(HEREDOC_RE.source, "y");

/** The command with heredoc bodies removed, and each body with the text before its operator. */
export function cutHeredocs(text: string): { text: string; docs: { before: string; body: string }[] } {
	if (!text.includes("<<")) return { text, docs: [] };
	const lines = text.split("\n");
	const out: string[] = [];
	const docs: { before: string; body: string }[] = [];
	let i = 0;
	while (i < lines.length) {
		const ln = lines[i];
		const masked = HEREDOC_RE.exec(maskQuotes(ln));
		if (masked) {
			// quotes were masked to find the operator; read the real delimiter from the original
			HEREDOC_AT.lastIndex = masked.index;
			const m = HEREDOC_AT.exec(ln) ?? masked;
			const name = m[2];
			const body: string[] = [];
			let j = i + 1;
			while (j < lines.length && lines[j].trim() !== name) body.push(lines[j++]);
			docs.push({ before: ln.slice(0, m.index), body: body.join("\n") });
			out.push(ln.slice(0, m.index) + ln.slice(m.index + m[0].length));
			i = j + 1;
			continue;
		}
		out.push(ln);
		i++;
	}
	return { text: out.join("\n"), docs };
}

export interface Segment {
	text: string;
	/** stdin is piped from the previous segment. */
	piped: boolean;
}

/**
 * Split on unquoted ; && || | & and newline. Returns the segments and the
 * bodies of $(...), <(...), >(...) and backticks, which are analysed as
 * further shell text.
 */
export function splitSegments(s: string): { segs: Segment[]; subs: string[] } {
	const segs: Segment[] = [];
	const subs: string[] = [];
	let cur = "";
	let q: string | null = null;
	let esc = false;
	let depth = 0;
	let subStart = -1;
	let piped = false;
	const push = (nextPiped: boolean) => {
		segs.push({ text: cur, piped });
		cur = "";
		piped = nextPiped;
	};
	let i = 0;
	const n = s.length;
	while (i < n) {
		const ch = s[i];
		if (esc) {
			cur += ch;
			esc = false;
			i++;
			continue;
		}
		if (ch === "\\" && q !== "'") {
			if (s[i + 1] === "\n") {
				cur += " ";
				i += 2;
				continue;
			}
			cur += ch;
			esc = true;
			i++;
			continue;
		}
		if (q) {
			if (ch === q) q = null;
			else if (q === '"' && ch === "$" && s[i + 1] === "(") {
				depth++;
				if (depth === 1) subStart = i + 2;
			} else if (q === '"' && ch === ")" && depth > 0) {
				depth--;
				if (depth === 0 && subStart >= 0) {
					subs.push(s.slice(subStart, i));
					subStart = -1;
				}
			}
			cur += ch;
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			q = ch;
			cur += ch;
			i++;
			continue;
		}
		if ((ch === "$" || ch === "<" || ch === ">") && s[i + 1] === "(") {
			// Consume both characters. (The labeller advanced one, so the "("
			// counted twice and an unquoted $(...) body was never analysed.)
			depth++;
			if (depth === 1) subStart = i + 2;
			cur += `${ch}(`;
			i += 2;
			continue;
		}
		if (ch === "(" && depth > 0) depth++;
		if (ch === ")" && depth > 0) {
			depth--;
			if (depth === 0 && subStart >= 0) {
				subs.push(s.slice(subStart, i));
				subStart = -1;
			}
			cur += ch;
			i++;
			continue;
		}
		if (depth > 0) {
			cur += ch;
			i++;
			continue;
		}
		if (ch === "`") {
			const j = s.indexOf("`", i + 1);
			if (j > i) {
				subs.push(s.slice(i + 1, j));
				cur += s.slice(i, j + 1);
				i = j + 1;
				continue;
			}
		}
		const two = s.slice(i, i + 2);
		if (two === "&&" || two === "||") {
			push(false);
			i += 2;
			continue;
		}
		if (ch === "|" && !(i > 0 && s[i - 1] === ">")) {
			push(true);
			i += two === "|&" ? 2 : 1;
			continue;
		}
		if (ch === "&" && !(i > 0 && s[i - 1] === ">") && s[i + 1] !== ">") {
			push(false);
			i++;
			continue;
		}
		if (ch === ";" || ch === "\n") {
			push(false);
			i++;
			continue;
		}
		cur += ch;
		i++;
	}
	segs.push({ text: cur, piped });
	return { segs: segs.map((x) => ({ text: x.text.trim(), piped: x.piped })).filter((x) => x.text), subs };
}

/**
 * POSIX shell-word split (quotes removed, backslash escapes applied, `#`
 * comments dropped). Returns null on an unclosed quote or trailing escape.
 */
export function shellWords(s: string): string[] | null {
	const out: string[] = [];
	let tok = "";
	let has = false;
	let i = 0;
	while (i < s.length) {
		const c = s[i];
		if (c === " " || c === "\t" || c === "\r" || c === "\n") {
			if (has) out.push(tok);
			tok = "";
			has = false;
			i++;
		} else if (c === "#") {
			if (has) out.push(tok);
			tok = "";
			has = false;
			while (i < s.length && s[i] !== "\n") i++;
		} else if (c === "\\") {
			if (i + 1 >= s.length) return null;
			tok += s[i + 1];
			has = true;
			i += 2;
		} else if (c === "'") {
			const j = s.indexOf("'", i + 1);
			if (j < 0) return null;
			tok += s.slice(i + 1, j);
			has = true;
			i = j + 1;
		} else if (c === '"') {
			i++;
			has = true;
			for (;;) {
				if (i >= s.length) return null;
				const d = s[i];
				if (d === '"') {
					i++;
					break;
				}
				if (d === "\\") {
					if (i + 1 >= s.length) return null;
					const e = s[i + 1];
					tok += e === '"' || e === "\\" ? e : `\\${e}`;
					i += 2;
					continue;
				}
				tok += d;
				i++;
			}
		} else {
			tok += c;
			has = true;
			i++;
		}
	}
	if (has) out.push(tok);
	return out;
}

const tokens = (seg: string) => shellWords(seg) ?? seg.split(/\s+/).filter(Boolean);

/** Global: only ever used through matchAll, which clones it, so lastIndex never leaks. */
const REDIR_RE = /(?<![<>&\d])(\d?|&)(>>?)(\|?)\s*([^\s;|&<>()]+)/g;

function redirects(seg: string): { op: string; target: string }[] {
	if (!seg.includes(">")) return [];
	const m = maskQuotes(seg);
	const outs: { op: string; target: string }[] = [];
	for (const mm of m.matchAll(REDIR_RE)) {
		const start = (mm.index ?? 0) + mm[0].length - mm[4].length;
		const target = seg.slice(start, start + mm[4].length).replace(/^['"]+|['"]+$/g, "");
		if (target.startsWith("&")) continue;
		outs.push({ op: mm[2], target });
	}
	return outs;
}

function stripRedirects(seg: string): string {
	if (!seg.includes(">") && !seg.includes("<")) return seg;
	const m = maskQuotes(seg);
	let s = "";
	let last = 0;
	for (const mm of m.matchAll(REDIR_RE)) {
		s += seg.slice(last, mm.index);
		last = (mm.index ?? 0) + mm[0].length;
	}
	s += seg.slice(last);
	return s.replace(/\d?>&\d|&>\S*|<\s*\S+/g, " ");
}

// ------------------------------------------------------------------ rules

function codeScan(code: string, r: Collector, tag: string): void {
	if (CODE_DELETE.test(code)) r.d(`${tag}_code_deletes`);
}

function sqlScan(sql: string, r: Collector): void {
	if (SQL_DESTRUCTIVE.test(sql)) r.d("sql_drop_truncate_delete");
}

function ruleRm(b: string, args: string[], r: Collector): void {
	const paths = positional(args);
	if (b === "rmdir") {
		if (!(paths.length && paths.every(isTemp))) r.d("rmdir_non_temp");
		return;
	}
	if (hasFlag(args, "rR", ["--recursive"])) {
		const hits = (p: string) => SYSTEM_PATH_RE.test(p) || HOME_TOP_RE.test(p) || (r.cwdDanger && p !== "" && CWD_TARGET_RE.test(p));
		// Each path as written, and every text it could expand to (#3314).
		const catastrophic = args.includes("--no-preserve-root") || paths.some((p) => hits(p) || expandCandidates(p, r.vars).some(hits));
		r.d("rm_recursive", catastrophic);
	} else if (!(paths.length && paths.every(isTemp))) {
		r.d("rm_non_temp");
	}
}

function ruleGit(args: string[], r: Collector): void {
	let a = [...args];
	while (a.length && a[0].startsWith("-")) {
		a = ["-C", "-c", "--git-dir", "--work-tree"].includes(a[0]) && a.length > 1 ? a.slice(2) : a.slice(1);
	}
	if (!a.length) return;
	const [sub, ...rest] = a;
	if (sub === "push") {
		if (
			hasFlag(rest, "f", ["--force", "--force-with-lease", "--force-if-includes", "--mirror", "--delete", "--prune"]) ||
			positional(rest).some((x) => x.startsWith("+") || (x.startsWith(":") && x.length > 1)) ||
			hasFlag(rest, "d")
		)
			r.d("git_push_force_or_delete");
	} else if (sub === "reset") {
		if (rest.includes("--hard") || rest.includes("--merge") || rest.includes("--keep")) r.d("git_reset_hard");
	} else if (sub === "clean") {
		if (!hasFlag(rest, "n", ["--dry-run"]) && hasFlag(rest, "fx", ["--force"])) r.d("git_clean_force");
	} else if (sub === "checkout") {
		if (rest.includes("--") || rest.includes(".") || hasFlag(rest, "f", ["--force"])) r.d("git_checkout_discards_changes");
	} else if (sub === "restore") {
		const stagedOnly = (rest.includes("--staged") || rest.includes("-S")) && !rest.includes("--worktree") && !rest.includes("-W");
		if (!stagedOnly) r.d("git_restore_discards_changes");
	} else if (sub === "stash") {
		if (rest[0] === "drop" || rest[0] === "clear") r.d("git_stash_drop_clear");
	} else if (sub === "branch") {
		if (rest.includes("-D") || (rest.includes("--delete") && rest.includes("--force")) || rest.includes("-df")) r.d("git_branch_force_delete");
	} else if (sub === "filter-branch" || sub === "filter-repo") {
		r.d("git_history_rewrite");
	} else if (sub === "update-ref") {
		if (rest.includes("-d")) r.d("git_update_ref_delete");
	} else if (sub === "worktree") {
		if (rest[0] === "remove" && hasFlag(rest.slice(1), "f", ["--force"])) r.d("git_worktree_remove_force");
	} else if (sub === "reflog") {
		if (rest[0] === "expire" || rest[0] === "delete") r.d("git_reflog_expire");
	} else if (sub === "switch") {
		if (hasFlag(rest, "fC", ["--force", "--discard-changes", "--force-create"])) r.d("git_switch_discards_changes");
	}
}

function ruleGh(args: string[], r: Collector): void {
	const pos = positional(args);
	if (!pos.length) return;
	const g = pos[0];
	const act = pos[1] ?? "";
	if (g === "api") {
		if (/(-X|--method)\s*=?\s*DELETE/.test(args.join(" "))) r.d("gh_api_delete");
		return;
	}
	if ((["delete", "remove", "rm", "unarchive"].includes(act) && GH_DELETE.test(g)) || (g === "repo" && act === "archive")) r.d("gh_delete");
}

function ruleDocker(args: string[], r: Collector): void {
	const j = positional(args).slice(0, 3).join(" ");
	if (/^((volume (rm|prune|remove))|(system prune)|(builder prune)|(compose .*down))/.test(j) && (!j.startsWith("compose") || hasFlag(args, "v", ["--volumes"])))
		r.d("docker_volume_rm_or_prune");
}

function ruleNpx(args: string[], r: Collector): void {
	const a = args.filter((x) => !["-y", "--yes", "-q", "--quiet"].includes(x) && !x.startsWith("--package"));
	if (!a.length) return;
	let tool = a[0].replace(/@[\d.^~<>=*x-]+$|@latest$/, "");
	if (tool.startsWith("@") && tool.split("/").length === 2 && tool !== "@biomejs/biome") tool = tool.split("/")[1];
	const rest = a.slice(1);
	const pos = positional(rest);
	if (tool === "convex") {
		const s = pos[0] ?? "";
		if ((s === "import" && rest.includes("--replace")) || (s === "data" && rest.includes("--delete")) || (s === "deployments" && pos.includes("delete")))
			r.d("convex_replace_or_delete");
		else if (s === "env" && (pos[1] === "remove" || pos[1] === "rm")) r.d("convex_env_remove");
	} else if (tool === "vercel") ruleVercel(rest, r);
	else if (tool === "wrangler") ruleWrangler(rest, r);
}

function ruleVercel(args: string[], r: Collector): void {
	const pos = positional(args);
	const s = pos[0] ?? "";
	const s2 = pos[1] ?? "";
	const groups = ["env", "domains", "alias", "dns", "certs", "secrets", "project", "projects", "teams", "blob", "integration"];
	if (s === "rm" || s === "remove" || ((s2 === "rm" || s2 === "remove") && groups.includes(s))) r.d("vercel_remove");
}

function ruleFly(args: string[], r: Collector): void {
	const pos = positional(args);
	const s = pos[0] ?? "";
	const s2 = pos[1] ?? "";
	const groups = ["apps", "app", "volumes", "volume", "machine", "machines", "m", "secrets", "ips", "certs", "postgres", "redis", "tokens", "ext"];
	if (s === "destroy" || (["destroy", "delete", "remove", "rm", "unset", "release"].includes(s2) && groups.includes(s)) || (s === "secrets" && s2 === "unset"))
		r.d("fly_destroy_or_unset");
}

function ruleWrangler(args: string[], r: Collector): void {
	if (positional(args).slice(0, 3).some((p) => ["delete", "rm", "remove", "purge"].includes(p))) r.d("wrangler_delete");
}

function rulePkg(b: string, args: string[], r: Collector): void {
	const pos = positional(args);
	const first = pos[0] ?? "";
	if (["npm", "pnpm", "yarn", "bun"].includes(b)) {
		if (first === "unpublish") {
			r.d(`${b}_unpublish`);
			return;
		}
		if (first === "x" || first === "exec") {
			ruleNpx(pos.slice(1), r);
			return;
		}
	}
	// inline code: bun -e / --eval / -p
	const i = args.findIndex((a) => ["-e", "--eval", "-p", "--print"].includes(a));
	if (b === "bun" && i >= 0 && i + 1 < args.length) codeScan(args[i + 1], r, "bun_inline");
}

function ruleCloud(b: string, args: string[], r: Collector): void {
	if (/\b(delete|destroy|terminate-instances|rb|rm|remove|purge|drop|reset|uninstall|apps:destroy|sites:delete|down|unset|wipe|deleteall|delete-\w+|flushall)\b/i.test(args.join(" ")))
		r.d(`cloud_delete:${b}`);
}

function ruleChmod(b: string, args: string[], r: Collector): void {
	const targets = positional(args).slice(1);
	if (targets.some((t) => SYSTEM_PATH_RE.test(t))) r.d(`${b}_system_path`);
}

function ruleKill(b: string, args: string[], r: Collector): void {
	const j = args.join(" ");
	const last = args[args.length - 1];
	if (b === "kill" && !j.includes("$(") && !j.includes("`") && (last === "1" || last === "-1" || /(^|\s)-(9|KILL|SIGKILL)\s+(-1|1)$/.test(j)))
		r.d("kill_all_or_launchd");
	else if ((b === "killall" || b === "pkill") && /\b(WindowServer|loginwindow|launchd|kernel_task|securityd|opendirectoryd|coreservicesd)\b/.test(j))
		r.d("kill_system_process");
}

/**
 * True when the segment's command writes nothing to stdout, so a `>` on it
 * only empties the target: a bare `> f`, `:`, `true`, `echo` with no text
 * (flags only, or ''), `printf ''`, `cat /dev/null`.
 */
function writesNothing(seg: string): boolean {
	const t = stripWrappers(tokens(stripRedirects(seg)));
	if (t.length === 0) return true;
	const [b, ...rest] = t;
	if ((b === ":" || b === "true") && rest.length === 0) return true;
	if (b === "echo") return rest.every((a) => a === "" || /^-[neE]+$/.test(a));
	if (b === "printf") return rest.length > 0 && rest.every((a) => a === "");
	return b === "cat" && rest.length === 1 && rest[0] === "/dev/null";
}

function ruleRedirects(seg: string, r: Collector): void {
	let empty: boolean | null = null;
	for (const { op, target } of redirects(seg)) {
		if (isTemp(target) || op !== ">") continue;
		if (SENSITIVE_FILE_RE.test(target)) r.d("truncate_sensitive_file");
		if (MANIFEST_RE.test(target)) r.d("overwrite_project_manifest");
		if (DOTFILE_EXTRA_RE.test(target)) r.d("truncate_dotfile");
		empty ??= writesNothing(seg);
		if (empty) r.d("empty_write_truncation");
	}
}

function stripWrappers(t: string[]): string[] {
	let changed = true;
	while (t.length && changed) {
		changed = false;
		while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) {
			t = t.slice(1);
			changed = true;
		}
		while (t.length && CONTROL.has(t[0])) {
			if (t[0] === "for" || t[0] === "select" || t[0] === "case") return [];
			t = t.slice(1);
			changed = true;
		}
		if (t.length) {
			const stripped = t[0].replace(/^[({]+/, "");
			if (stripped !== t[0] && stripped) {
				t = [stripped, ...t.slice(1)];
				changed = true;
			}
		}
		if (t.length && WRAPPERS.has(t[0])) {
			const w = t[0];
			t = t.slice(1);
			if (w === "command" && (t[0] === "-v" || t[0] === "-V")) return ["which", ...t.slice(1)];
			if ((w === "timeout" || w === "gtimeout") && t.length) {
				while (t.length && t[0].startsWith("-")) t = t.slice(1);
				t = t.slice(1);
			} else if (w === "nice") {
				while (t.length && t[0].startsWith("-")) t = t.slice(t[0] === "-n" ? 2 : 1);
			} else if (w === "sudo" || w === "doas") {
				while (t.length && t[0].startsWith("-")) t = t.slice(["-u", "-g", "-C", "-p"].includes(t[0]) ? 2 : 1);
			} else if (["env", "caffeinate", "arch", "stdbuf"].includes(w)) {
				while (t.length && t[0].startsWith("-")) t = t.slice(["-u", "-C", "-S", "-t", "-w"].includes(t[0]) ? 2 : 1);
			}
			changed = true;
		}
	}
	return t;
}

function analyseTokens(tIn: string[], piped: boolean, prevBin: string | null, r: Collector, depth: number): string | null {
	const t = stripWrappers(tIn);
	if (!t.length) return null;
	const b = t[0].startsWith("$") ? t[0] : basename(t[0]);
	const args = t.slice(1);
	if (b.startsWith("$") || b.startsWith("<")) return b;

	if (b === "xargs") {
		let a = [...args];
		while (a.length && a[0].startsWith("-")) a = a.slice(["-n", "-I", "-P", "-L", "-d", "-s", "-E", "-J"].includes(a[0]) ? 2 : 1);
		return a.length ? analyseTokens(a, piped, prevBin, r, depth) : "xargs";
	}
	if (SHELLS.has(b)) {
		const idx = args.findIndex((a) => a === "-c" || /^-\w*c$/.test(a));
		if (idx >= 0) {
			if (idx + 1 < args.length) analyse(args[idx + 1], r, depth + 1);
		} else if (piped && prevBin && NET_FETCHERS.has(prevBin)) r.d("remote_code_piped_to_shell");
		return b;
	}
	if (b === "eval" || b === "watch") {
		analyse(args.filter((a) => !a.startsWith("-") || b === "eval").join(" "), r, depth + 1);
		return b;
	}
	if (b === "ssh" || b === "mosh") {
		let a = [...args];
		while (a.length) {
			if (a[0].startsWith("-")) {
				a = a.slice(/^-[bcDEeFIiJLlmOopQRSWw]$/.test(a[0]) ? 2 : 1);
				continue;
			}
			a = a.slice(1); // host
			break;
		}
		if (a.length) analyse(a.join(" "), r, depth + 1);
		return b;
	}
	if (INTERPRETERS.has(b) && b !== "bun") {
		if (piped && prevBin && NET_FETCHERS.has(prevBin) && !positional(args).length) {
			r.d("remote_code_piped_to_interpreter");
			return b;
		}
		if (b === "osascript" || (b === "perl" && args.some((x) => /^-\w*i/.test(x)))) return b;
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			if (!a.startsWith("-")) break; // first positional is the script; later flags belong to it
			if (["-c", "-e", "--eval", "-p", "--print", "-E"].includes(a) && i + 1 < args.length) {
				codeScan(args[i + 1], r, "inline");
				break;
			}
		}
		return b;
	}

	if (b === "rm" || b === "rmdir") ruleRm(b, args, r);
	else if (b === "unlink") r.d("unlink");
	else if (b === "dd") {
		const of = args.find((a) => a.startsWith("of=") && !isTemp(a.slice(3)));
		if (of) r.d("dd_of", of.slice(3).startsWith("/dev/"));
	} else if (DESTRUCTIVE_ALWAYS.has(b) || b.startsWith("mkfs") || b.startsWith("newfs")) r.d("disk_format_or_wipe");
	else if (b === "truncate") r.d("truncate_file");
	else if (b === "git") ruleGit(args, r);
	else if (b === "gh") ruleGh(args, r);
	else if (b === "docker" || b === "docker-compose" || b === "podman") ruleDocker(b === "docker-compose" ? ["compose", ...args] : args, r);
	else if (NET_FETCHERS.has(b)) {
		if (/(-X|--request)\s*=?\s*DELETE/.test(args.join(" "))) r.d("http_delete");
	} else if (["npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "brew", "cargo", "go", "make"].includes(b)) rulePkg(b, args, r);
	else if (b === "npx" || b === "bunx" || b === "pnpx") ruleNpx(args, r);
	else if (b === "vercel") ruleVercel(args, r);
	else if (b === "fly" || b === "flyctl") ruleFly(args, r);
	else if (b === "wrangler") ruleWrangler(args, r);
	else if (b === "convex") ruleNpx(["convex", ...args], r);
	else if (CLOUD_BINS.has(b)) ruleCloud(b, args, r);
	else if (["chmod", "chown", "chgrp", "chflags"].includes(b)) ruleChmod(b, args, r);
	else if (["kill", "killall", "pkill"].includes(b)) ruleKill(b, args, r);
	else if (b === "find") {
		const j = args.join(" ");
		if (args.includes("-delete") || /-exec(dir)?\s+(rm|unlink|shred|truncate)\b/.test(j) || /-exec(dir)?\s+\S*sh\s+-c\s+.*\brm\b/.test(j)) r.d("find_delete");
		else {
			const idx = args.findIndex((a) => a === "-exec" || a === "-execdir" || a === "-ok");
			if (idx >= 0) {
				const inner = args.slice(idx + 1).filter((a) => ![";", "+", "\\;", "{}"].includes(a));
				analyseTokens(inner, false, null, r, depth + 1);
			}
		}
	} else if (["cp", "mv", "ditto", "install"].includes(b)) {
		const pos = positional(args);
		const dest = pos[pos.length - 1] ?? "";
		const safeCase =
			(b === "cp" && dest && isTemp(dest)) ||
			(b === "mv" && dest.includes("/.Trash")) ||
			(b === "cp" && !hasFlag(args, "f", ["--force"]) && dest.endsWith("/"));
		if (!safeCase && (SENSITIVE_FILE_RE.test(dest) || pos.some((p) => SYSTEM_PATH_RE.test(p)))) r.d(`${b}_overwrites_sensitive_or_system`);
		if (b === "cp" && pos.length === 2 && pos[0] === "/dev/null" && dest && !isTemp(dest)) {
			r.d("empty_write_truncation");
			if (MANIFEST_RE.test(dest)) r.d("overwrite_project_manifest");
			if (DOTFILE_EXTRA_RE.test(dest)) r.d("truncate_dotfile");
		}
	} else if (b === "tee") {
		const files = positional(args);
		const truncating = !hasFlag(args, "a", ["--append"]);
		if (files.length && !files.every(isTemp) && files.some((f) => SENSITIVE_FILE_RE.test(f)) && truncating)
			r.d("truncate_sensitive_file");
		if (truncating && files.some((f) => !isTemp(f) && MANIFEST_RE.test(f))) r.d("overwrite_project_manifest");
		if (truncating && files.some((f) => !isTemp(f) && DOTFILE_EXTRA_RE.test(f))) r.d("truncate_dotfile");
	} else if (b === "launchctl") {
		if (["bootout", "unload", "remove", "disable"].includes(positional(args)[0] ?? "")) r.d("launchctl_bootout_unload");
	} else if (b === "crontab") {
		if (args.includes("-r")) r.d("crontab_remove");
	} else if (b === "defaults") {
		if (positional(args)[0] === "delete") r.d("defaults_delete");
	} else if (b === "security") {
		if ((positional(args)[0] ?? "").startsWith("delete")) r.d("keychain_delete");
	} else if (b === "diskutil") {
		const s = positional(args)[0] ?? "";
		if (s.startsWith("erase") || ["zeroDisk", "randomDisk", "secureErase", "partitionDisk", "reformat"].includes(s) || /apfs\s+(delete\w+|eraseVolume)/.test(args.join(" ")))
			r.d("diskutil_erase");
	} else if (b === "tmutil") {
		if (["delete", "disable", "deletelocalsnapshots", "thinlocalsnapshots"].includes(positional(args)[0] ?? "")) r.d("tmutil_delete");
	} else if (b === "csrutil" || b === "spctl" || b === "nvram") {
		if (/disable|--master-disable|-c\b|-d\b|clear/.test(args.join(" "))) r.d(`${b}_disable_or_clear`);
	} else if (DB_CLIENTS.has(b)) sqlScan(args.join(" "), r);
	else if (b === "rsync") {
		if (/--delete\b|--delete-\w+|--remove-source-files/.test(args.join(" "))) r.d("rsync_delete");
	} else if (b === "xcrun") {
		if (/simctl\s+(delete|erase)/.test(args.join(" "))) r.d("simulator_delete_or_erase");
	}
	return b;
}

function analyse(text: string, r: Collector, depth = 0): void {
	if (depth > MAX_DEPTH) {
		r.d("nesting_too_deep");
		return;
	}
	const { text: body, docs } = cutHeredocs(text);
	// Whole-command rules, on this level's text with quoted data masked.
	const view = maskData(body);
	if (REMOTE_EXEC_RE.test(view)) r.d("remote_code_substituted_into_shell");
	if (SECRET_READ.test(view)) r.secretRead = true;
	if (NET_SINK.test(view)) r.netSink = true;

	for (const { before, body: doc } of docs) {
		const segs = splitSegments(before).segs;
		const last = segs[segs.length - 1];
		const t = last ? stripWrappers(tokens(stripRedirects(last.text))) : [];
		const consumer = t.length ? basename(t[0]) : null;
		if (consumer && (SHELLS.has(consumer) || consumer === "ssh")) analyse(doc, r, depth + 1);
		else if (consumer && INTERPRETERS.has(consumer)) codeScan(doc, r, "heredoc");
		else if (consumer && DB_CLIENTS.has(consumer)) sqlScan(doc, r);
		// cat/tee/etc: the body is file content; the redirect on the line is checked below.
	}
	const { segs, subs } = splitSegments(body);
	let prev: string | null = null;
	for (const { text: seg, piped } of segs) {
		ruleRedirects(seg, r);
		const t = tokens(stripRedirects(seg));
		prev = analyseTokens(t, piped, prev, r, depth);
		trackShellState(t, r);
	}
	for (const s of subs) analyse(s, r, depth + 1);
}

export interface DecideRulesOptions {
	/**
	 * The directory the command runs in. When it is home or a system path, a
	 * recursive delete of `*`, `.`, `./*` or `.*` blocks (#3314). Omitted:
	 * only a `cd` on the same line can set it.
	 */
	cwd?: string;
}

/** Run the rule pre-filter on one command. Pure, synchronous, never throws. */
export function decideRules(command: string, opts: DecideRulesOptions = {}): RuleResult {
	const r = new Collector();
	try {
		if (opts.cwd) r.cwdDanger = dangerousDir(opts.cwd);
		analyse(command, r);
		if (r.secretRead && r.netSink) r.d("secret_to_network");
	} catch {
		// A parser failure is never a pass: it is escalated.
		r.d("parse_error");
	}
	const rules = [...new Set(r.fired.map((f) => f.rule))];
	const block = r.fired.find((f) => f.block);
	if (block) return { verdict: "block", rule: block.rule, rules };
	if (rules.length) return { verdict: "escalate", rule: rules[0], rules };
	return { verdict: "pass", rules };
}
