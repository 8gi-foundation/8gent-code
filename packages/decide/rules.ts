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
	"nesting_too_deep",
	"keychain_delete",
	"keychain_dump",
	"fork_bomb",
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
const DOTFILE_EXTRA_RE =
	/(^|\/)(\.zshenv|\.zlogin|\.bash_login|\.bash_logout|\.inputrc|\.vimrc|\.tmux\.conf|\.ssh\/config)$/;
/**
 * The text scans below were one regex each with `[^|;&\n]*` after a keyword. Every keyword
 * occurrence rescanned to the end of its segment, so `cat cat cat ...` took quadratic time
 * (minutes on a few MB). Each is now: split into segments once, find the first keyword in a
 * segment, test the tail of that segment once. Same verdicts: the tail of the first keyword
 * holds every tail of a later keyword in the same segment.
 */
const SEG_SPLIT = /[|;&\n]/;
const NET_SINK_SIMPLE = /(?:^|[\s|;&(])(?:nc|ncat|netcat|scp|sftp|ftp|telnet)\b/;
const NET_CURL_START = /(?:^|[\s|;&(])curl\b/;
const NET_CURL_TAIL =
	/\s-d\b|\s--data|\s-F\b|\s--form|\s-T\b|\s--upload-file|\s-X\s*(?:POST|PUT|PATCH)/;
const NET_WGET_START = /(?:^|[\s|;&(])wget\b/;
const NET_RSYNC_START = /(?:^|[\s|;&(])rsync\b/;

/** Same as the old NET_SINK regex, in linear time. */
function hasNetSink(view: string): boolean {
	if (NET_SINK_SIMPLE.test(view)) return true;
	for (const seg of view.split(SEG_SPLIT)) {
		const c = NET_CURL_START.exec(seg);
		if (c && NET_CURL_TAIL.test(seg.slice(c.index + c[0].length))) return true;
		const w = NET_WGET_START.exec(seg);
		if (w && seg.indexOf("--post", w.index + w[0].length) >= 0) return true;
		const r = NET_RSYNC_START.exec(seg);
		if (r && /\S:/.test(seg.slice(r.index + r[0].length))) return true;
	}
	return false;
}

const SECRET_READER = /(?:cat|less|head|tail|base64|xxd|od|strings|tar|zip|gpg)\s/;
const SECRET_FILE =
	/\.env\b|\.ssh\/id_\w+(?!\w|\.pub)|id_rsa(?!\.pub)|id_ed25519(?!\.pub)|\.aws\/credentials|\.netrc|\.git-credentials|\.npmrc|keychain-db/;
const SECRET_ENV_DUMP = /(?:^|[|;&\s(])(?:env|printenv|set)\s*(?:\||>)/;
const SECRET_AT_FILE = /\.env\b|\.ssh\/|id_rsa|id_ed25519|credentials|\.netrc/;
const SECRET_KEYCHAIN = /security\s+find-(?:generic|internet)-password/g;
const SECRET_PIPE_NET = /\|\s*(?:curl|nc|ssh)/g;
const SCP_WORD = /(?:scp|rsync|sftp)$/;
const SCP_SECRET_WORD =
	/^[^|;&]*?(?:\.env\b|\.ssh\/id_\w+(?!\w|\.pub)|id_rsa(?!\.pub)|\.aws\/credentials)/;
/** How many words after scp, rsync or sftp the option parser reads. */
const SCP_LOOKAHEAD = 64;

/**
 * `scp [-o [value]]... <path to a secret> <host:...>`: a secret named as the source of a copy to
 * a remote end. An option may or may not take a value, so both readings are followed (the old
 * regex backtracked over them, exponentially).
 */
function scpSecretToRemote(words: string[], k: number): boolean {
	const reach = new Array<boolean>(SCP_LOOKAHEAD + 3).fill(false);
	reach[0] = true;
	for (let o = 0; o <= SCP_LOOKAHEAD; o++) {
		const w = words[k + 1 + o];
		if (!reach[o] || w === undefined) continue;
		if (SCP_SECRET_WORD.test(w)) {
			const next = words[k + 2 + o];
			if (next !== undefined && next.indexOf(":", 1) > 0) return true;
		}
		if (/^-\w+$/.test(w)) {
			reach[o + 1] = true;
			reach[o + 2] = true;
		}
	}
	// Still inside an option run past the lookahead: not read, so not trusted. Fail closed.
	return reach[SCP_LOOKAHEAD + 1] === true || reach[SCP_LOOKAHEAD + 2] === true;
}

/** Same as the old SECRET_READ regex, in linear time. */
function hasSecretRead(view: string): boolean {
	if (SECRET_ENV_DUMP.test(view)) return true;
	for (const seg of view.split(SEG_SPLIT)) {
		const m = SECRET_READER.exec(seg);
		if (m && SECRET_FILE.test(seg.slice(m.index + m[0].length))) return true;
	}
	// `@file` upload arguments: one run of non-space, non-quote characters at a time.
	if (view.includes("@")) {
		for (const run of view.split(/[\s"']+/)) {
			const a = run.indexOf("@");
			if (a >= 0 && SECRET_AT_FILE.test(run.slice(a + 1))) return true;
		}
	}
	if (/scp|rsync|sftp/.test(view)) {
		const words = view.split(/\s+/);
		for (let k = 0; k < words.length - 1; k++)
			if (SCP_WORD.test(words[k] as string) && scpSecretToRemote(words, k)) return true;
	}
	if (view.includes("security")) {
		for (const line of view.split("\n")) {
			if (!line.includes("security")) continue;
			let lastPipe = -1;
			for (const p of line.matchAll(SECRET_PIPE_NET)) lastPipe = p.index ?? -1;
			if (lastPipe < 0) continue;
			// Pointers only move forward, so a line full of matches is still one pass.
			let nextW = -2;
			let nextStop = -2;
			for (const m of line.matchAll(SECRET_KEYCHAIN)) {
				const tail = (m.index ?? 0) + m[0].length;
				if (nextW < tail) {
					nextW = line.indexOf("-w", tail);
					if (nextW < 0) break;
				}
				if (nextStop < tail) {
					const stop = /[|;&]/g;
					stop.lastIndex = tail;
					nextStop = stop.exec(line)?.index ?? Number.POSITIVE_INFINITY;
				}
				if (nextW < nextStop && lastPipe >= nextW + 2) return true;
			}
		}
	}
	return false;
}
const REMOTE_EXEC_RE =
	/(?:ba|z|da|k)?sh\s+(?:-\w+\s+)*["']?\$\((?:curl|wget)\b|<\((?:curl|wget)\b|\beval\s+["']?\$\((?:curl|wget)\b/;

const SHUTDOWN_BINS = new Set(["shutdown", "reboot", "halt", "poweroff"]);
/** Programs that print or copy a file's bytes into the transcript or elsewhere. */
const CRED_READERS = new Set([
	"cat",
	"less",
	"more",
	"head",
	"tail",
	"bat",
	"nl",
	"tac",
	"xxd",
	"od",
	"strings",
	"base64",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"awk",
	"gawk",
	"sed",
	"cp",
	"vim",
	"vi",
	"view",
	"nano",
	"emacs",
	"sort",
	"cut",
	"diff",
	"paste",
	"openssl",
]);
/** Readers that walk a directory, so a credential folder is a read of what is in it. */
const DIR_READERS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "cp"]);
/** Programs that pack or copy a credential into something that can then be sent. */
const PACKERS = new Set(["tar", "zip", "7z", "7za", "cpio", "gzip", "bzip2", "xz", "cp"]);
/** Credential stores outside the project: reading one puts the secret in the model's context. */
const CRED_FILES = [
	".aws/credentials",
	".ssh/id_rsa",
	".ssh/id_ed25519",
	".ssh/id_ecdsa",
	".ssh/id_dsa",
	".ssh/identity",
	".netrc",
	".git-credentials",
	".gnupg/secring.gpg",
	".gnupg/private-keys-v1.d/k",
	".config/gh/hosts.yml",
	".docker/config.json",
	".kube/config",
];
const CRED_DIR_NAMES = [".aws", ".ssh", ".gnupg", ".kube", ".docker"];
const CREDENTIAL_FILE_RE =
	/(^|\/)(\.aws\/credentials|\.ssh\/(id_[\w.-]+|identity)|\.netrc|\.git-credentials|\.gnupg\/(secring\.gpg|private-keys-v1\.d(\/.*)?)|\.config\/gh\/hosts\.yml|\.docker\/config\.json|\.kube\/config)$/;
const CRED_DIR_RE = /(^|\/)\.(aws|ssh|gnupg|kube|docker)$/;
/** Folders where a bare `config` is a credential file (kubeconfig, docker config.json). */
const CRED_CONFIG_DIR_RE = /(^|\/)\.(kube|docker)$/;
/** A credential name on its own, for a `cat credentials` after a `cd` into the folder. */
const CRED_NAME_RE =
	/^(credentials|id_[\w.-]+|identity|\.netrc|\.git-credentials|hosts\.yml|secring\.gpg)$/;
/** Credential paths named inside code text (python -c, a heredoc to an interpreter). */
const CRED_TEXT_RE =
	/\.aws\/credentials|\.ssh\/id_[A-Za-z0-9_]+(?!\w|\.pub)|\.netrc|\.git-credentials|\.gnupg\/(?:secring|private-keys)/;
/** A credential folder named as text (an sftp `put -r .ssh`). */
const CRED_DIR_TEXT_RE = /(?:^|[\s/'"~])\.(?:ssh|aws|gnupg)(?![\w.-])/;
const PIPE_TO_SSH = /\|\s*(?:sudo\s+)?ssh\b/;

/** `~`, `$HOME`, `/Users/x` to `~`; drop `//`, `/./`, trailing `/`; fold `..`. Linear. */
function normPath(raw: string): string {
	const p = raw.replace(/^(?:\$HOME|\$\{HOME\}|\/Users\/[^/]+|\/home\/[^/]+)(?=\/|$)/, "~");
	const out: string[] = [];
	const parts = p.split("/");
	for (let i = 0; i < parts.length; i++) {
		const seg = parts[i] as string;
		if (i > 0 && (seg === "" || seg === ".")) continue;
		const top = out[out.length - 1];
		if (seg === ".." && top !== undefined && top !== ".." && top !== "~" && top !== "") {
			out.pop();
			continue;
		}
		out.push(seg);
	}
	return out.join("/");
}

/** One glob segment as a regex source. A leading `*` or `?` never matches a leading dot, as in the shell. */
function globSegment(seg: string): string {
	const body = seg
		.replace(/\*+/g, "*")
		.replace(/\[[^\]]*\]/g, "?")
		.replace(/[.+^${}()|\\]/g, "\\$&")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]");
	return (/^[*?[]/.test(seg) ? "(?!\\.)" : "") + body;
}

/** Folders whose names can make a relative glob a credential read (`.ssh/id_*`). */
const CRED_GLOB_DIRS = new Set([".aws", ".ssh", ".gnupg", ".kube", ".docker", ".config", "gh"]);
const CRED_BASENAMES = [
	...new Set(
		CRED_FILES.map((c) => c.slice(c.lastIndexOf("/") + 1)).concat(["config", "config.json"]),
	),
];

/**
 * Does this argument name a credential store? "file" for a key or credentials file, "dir" for a
 * credential folder, null otherwise. Handles quotes, `--opt=PATH`, `//`, `/./`, `..` and globs.
 * `inCredDir`: a `cd` on this line went into a credential folder, so a folderless glob (`*`,
 * `cred*`) can name a credential there; anywhere else it does not (`cat *.json` is not one).
 */
function credKind(raw: string, inCredDir = false): "file" | "dir" | null {
	let p = raw;
	if (p.startsWith("-")) {
		const eq = p.indexOf("=");
		if (eq < 0) return null;
		p = p.slice(eq + 1);
	}
	p = p.replace(/^['"]+|['"]+$/g, "");
	if (!p || p.length > 4096) return null;
	p = normPath(p);
	if (inCredDir && (p === "." || p === "")) return "dir";
	if (p.endsWith(".pub")) return null;
	if (!/[*?[]/.test(p)) {
		if (CREDENTIAL_FILE_RE.test(p)) return "file";
		return CRED_DIR_RE.test(p) ? "dir" : null;
	}
	if (p.length > 256) return CRED_DIR_TEXT_RE.test(p) ? "file" : null;
	const segs = p.split("/");
	if (segs.length === 1) {
		if (!inCredDir) return null;
		const re = new RegExp(`^${globSegment(p)}$`);
		return CRED_BASENAMES.some((c) => re.test(c)) ? "file" : null;
	}
	const body = segs.map(globSegment).join("/");
	if (p.startsWith("~/")) {
		const re = new RegExp(`^${body}$`);
		if (CRED_FILES.some((c) => re.test(`~/${c}`))) return "file";
		return CRED_DIR_NAMES.some((c) => re.test(`~/${c}`)) ? "dir" : null;
	}
	// Relative or absolute elsewhere: needs a literal credential folder in the path.
	if (!segs.some((x) => CRED_GLOB_DIRS.has(x))) return null;
	const re = new RegExp(`(?:^|/)${body}$`);
	if (CRED_FILES.some((c) => re.test(`~/${c}`))) return "file";
	return CRED_DIR_NAMES.some((c) => re.test(`~/${c}`)) ? "dir" : null;
}

/** `user@host:/path` or `host:path`: a remote end of scp, rsync or sftp. */
function isRemoteSpec(a: string): boolean {
	return !a.startsWith("-") && /^[^\s/:][^\s/:]*:/.test(a);
}

const FB_KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "time"]);
const FB_BOUNDARY = /[\s;&|(){}<>`"']/;
const fbEdge = (c: string | undefined): boolean => c === undefined || FB_BOUNDARY.test(c);
/** Total body text the fork-bomb check will read. Over this, a command is not judged: it is a bomb. */
const FB_BUDGET = 12_000_000;
const FB_MAX_DEFS = 64;

/**
 * The words of `body` that are in command position: the first word of a simple command, after
 * `;`, `|`, `&`, `(`, `{` or a newline. `npm run build &` has the word `build` but it is an
 * argument, not a call. One pass.
 */
function commandWords(body: string): string[] {
	const out: string[] = [];
	let cmdPos = true;
	let i = 0;
	while (i < body.length) {
		const c = body[i] as string;
		if (!FB_BOUNDARY.test(c)) {
			let j = i + 1;
			while (j < body.length && !FB_BOUNDARY.test(body[j] as string)) j++;
			const word = body.slice(i, j);
			if (cmdPos) out.push(word);
			// `then f`, `do f`, `else f`: the word after a shell keyword is still a command.
			cmdPos = cmdPos && FB_KEYWORDS.has(word);
			i = j;
			continue;
		}
		if (";|&({\n".includes(c)) cmdPos = true;
		else if (!/\s/.test(c)) cmdPos = false;
		i++;
	}
	return out;
}

/**
 * A shell function that, directly or through other functions defined on the line, calls itself
 * while backgrounding (`&`): `:(){ :|:& };:`, `.(){ .|.& };.`, `f(){ f & f & }; f`,
 * `f(){ g|g& }; g(){ f|f& }`, `function f { f|f& }`. Any function name. Text only, linear:
 * at most FB_MAX_DEFS definitions are read (more is treated as a bomb), each body once.
 */
function hasForkBomb(text: string): boolean {
	if (!text.includes("&") || !text.includes("{")) return false;
	const defs: { name: string; open: number }[] = [];
	const ws = (c: string | undefined) => c !== undefined && /\s/.test(c);
	// name(){  and  name () {
	for (let i = text.indexOf("("); i >= 0; i = text.indexOf("(", i + 1)) {
		let j = i + 1;
		while (text[j] === " " || text[j] === "\t") j++;
		if (text[j] !== ")") continue;
		j++;
		while (ws(text[j])) j++;
		if (text[j] !== "{") continue;
		let end = i;
		while (end > 0 && i - end < 64 && ws(text[end - 1])) end--;
		let st = end;
		while (st > 0 && end - st < 64 && !fbEdge(text[st - 1])) st--;
		if (st === end) continue;
		defs.push({ name: text.slice(st, end), open: j });
		if (defs.length > FB_MAX_DEFS) return true;
	}
	// function name {
	for (let i = text.indexOf("function"); i >= 0; i = text.indexOf("function", i + 1)) {
		if (!fbEdge(text[i - 1]) || !ws(text[i + 8])) continue;
		let j = i + 8;
		while (ws(text[j])) j++;
		const st = j;
		while (j < text.length && j - st < 64 && !fbEdge(text[j])) j++;
		const name = text.slice(st, j);
		while (ws(text[j])) j++;
		if (text[j] === "(") {
			j++;
			while (ws(text[j])) j++;
			if (text[j] !== ")") continue;
			j++;
			while (ws(text[j])) j++;
		}
		if (!name || text[j] !== "{") continue;
		defs.push({ name, open: j });
		if (defs.length > FB_MAX_DEFS) return true;
	}
	if (!defs.length) return false;
	const amp = new Map<string, boolean>();
	const calls = new Map<string, Set<string>>();
	const names = new Set(defs.map((d) => d.name));
	let read = 0;
	for (const d of defs) {
		let depth = 0;
		let end = text.length;
		for (let k = d.open; k < text.length; k++) {
			const c = text[k];
			if (c === "{") depth++;
			else if (c === "}" && --depth === 0) {
				end = k;
				break;
			}
		}
		read += end - d.open;
		if (read > FB_BUDGET) return true;
		const body = text.slice(d.open + 1, end);
		let bg = amp.get(d.name) ?? false;
		for (let k = body.indexOf("&"); k >= 0 && !bg; k = body.indexOf("&", k + 1)) {
			const pv = body[k - 1];
			const nx = body[k + 1];
			if (pv !== "&" && nx !== "&" && pv !== ">" && nx !== ">" && pv !== "<") bg = true;
		}
		amp.set(d.name, bg);
		const set = calls.get(d.name) ?? new Set<string>();
		for (const w of commandWords(body)) if (names.has(w)) set.add(w);
		calls.set(d.name, set);
	}
	for (const [f, bg] of amp) {
		if (!bg) continue;
		const seen = new Set<string>();
		const stack = [...(calls.get(f) ?? [])];
		while (stack.length) {
			const n = stack.pop() as string;
			if (n === f) return true;
			if (seen.has(n)) continue;
			seen.add(n);
			stack.push(...(calls.get(n) ?? []));
		}
	}
	return false;
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const INTERPRETERS = new Set([
	"python",
	"python3",
	"python3.11",
	"python3.12",
	"python3.13",
	"node",
	"bun",
	"deno",
	"ruby",
	"perl",
	"php",
	"osascript",
	"tsx",
	"ts-node",
]);
const DB_CLIENTS = new Set([
	"psql",
	"sqlite3",
	"mysql",
	"mongosh",
	"mongo",
	"redis-cli",
	"duckdb",
	"clickhouse-client",
]);
const WRAPPERS = new Set([
	"sudo",
	"nohup",
	"time",
	"command",
	"builtin",
	"exec",
	"stdbuf",
	"unbuffer",
	"caffeinate",
	"nice",
	"timeout",
	"gtimeout",
	"env",
	"doas",
	"arch",
	"noglob",
	"!",
]);
const CONTROL = new Set([
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"do",
	"done",
	"while",
	"until",
	"for",
	"case",
	"esac",
	"in",
	"{",
	"}",
	"(",
	")",
	"function",
	"select",
	"[[",
	"]]",
	"!",
	"coproc",
]);
const DESTRUCTIVE_ALWAYS = new Set([
	"mkfs",
	"newfs_apfs",
	"newfs_hfs",
	"newfs_msdos",
	"fdisk",
	"gpt",
	"shred",
	"srm",
	"wipefs",
	"sgdisk",
	"parted",
]);
const CLOUD_BINS = new Set([
	"aws",
	"gcloud",
	"gsutil",
	"az",
	"kubectl",
	"helm",
	"terraform",
	"tofu",
	"pulumi",
	"heroku",
	"railway",
	"netlify",
	"supabase",
	"doctl",
	"stripe",
	"firebase",
	"hcloud",
	"linode-cli",
	"oci",
	"render",
	"neonctl",
	"turso",
	"planetscale",
	"pscale",
	"upstash",
	"cloudflared",
]);
const NET_FETCHERS = new Set(["curl", "wget", "http"]);

const CODE_DELETE =
	/shutil\.rmtree|os\.remove\(|os\.unlink\(|os\.rmdir\(|\.unlink\(|rmSync|unlinkSync|rmdirSync|fs\.rm\(|fs\.promises\.rm\b|fsp?\.rm\(|\brm\s+-[a-zA-Z]*[rf]|DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM|File\.delete|FileUtils\.rm|\.drop\(\)|dropDatabase/i;
const SQL_DESTRUCTIVE =
	/\b(DROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW|COLLECTION)|TRUNCATE\b|DELETE\s+FROM|FLUSHALL|FLUSHDB|dropDatabase|\.drop\(\)|deleteMany|\bDEL\s+\w)/i;
const GH_DELETE =
	/^(repo|release|issue|label|secret|variable|run|cache|gist|ssh-key|gpg-key|project|codespace|ruleset|extension)$/;
const MAX_DEPTH = 6;
/** `xargs xargs xargs ...` deeper than this is not a real command: it escalates. */
const MAX_XARGS_CHAIN = 100;

// ------------------------------------------------------------------ result

class Collector {
	readonly fired: { rule: string; block: boolean }[] = [];
	/** A secret was read somewhere in the command (any nesting level). */
	secretRead = false;
	/** A network sender appears somewhere in the command (any nesting level). */
	netSink = false;
	/**
	 * Same-line `NAME=value` / `export NAME=value` assignments seen so far
	 * (#3314). Each name keeps EVERY value it was given on the line, already
	 * expanded against the state before that assignment: the text cannot tell
	 * which assignment ran (`D=/; false && D=build`), so any of them may hold.
	 * An absent name is unknown. null = too many values to judge (overflow).
	 */
	readonly vars = new Map<string, string[] | null>();
	/** The working directory is home or a system path (from the caller, or a `cd` on this line). */
	cwdDanger = false;
	/** A `cd` on this line went into a credential folder (~/.aws, ~/.ssh ...). */
	credCwd = false;
	/** The `cd` went into ~/.kube or ~/.docker, where a bare `config` is a credential. */
	credCwdConfig = false;
	/** This line has `&&`, `||` or a compound command, so an assignment on it may not have run. */
	conditional = false;
	d(rule: string, block = BLOCK_RULES.has(rule)): void {
		this.fired.push({ rule, block });
	}
}

// ------------------------------------------------------------------ variables (#3314)

/** `$NAME`, `${NAME}`, `${NAME<op>word}` (one level of nested braces in word), `$0`..`$9`, `$@`, `$*`. */
const VAR_REF_RE = new RegExp(
	[
		String.raw`\$(?:\{([A-Za-z_][A-Za-z0-9_]*|[0-9@*])`, // ${NAME
		String.raw`(?:(:?[-=?+])((?:[^{}]|\{[^{}]*\})*))?\}`, // optional <op>word, then }
		String.raw`|([A-Za-z_][A-Za-z0-9_]*|[0-9@*]))`, // or $NAME
	].join(""),
);
const MAX_CANDIDATES = 64;
const MAX_NESTING = 8;
/** References in one argument; past this the argument is not judged (block). */
const MAX_REFS = 64;
function countDollars(p: string): number {
	let n = 0;
	for (let i = p.indexOf("$"); i >= 0 && n <= MAX_REFS; i = p.indexOf("$", i + 1)) n++;
	return n;
}
/** A target that names the working directory itself or everything in it: `.`, `*`, `./*`, `.*`. */
const CWD_TARGET_RE = /^(\.\/)*(\.|\*|\.\*)?\/?$/;
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
const DECLARERS = new Set(["export", "declare", "typeset", "local", "readonly"]);
/** `&&`, `||` or a compound-command keyword, in quote-masked text. */
const CONDITIONAL_RE = /&&|\|\||(^|[\s;&|(])(if|then|else|elif|while|until|do|case)(?=[\s;]|$)/;
const HOME_DIR = homedir().replace(/\/+$/, "");

/** Too many candidates, or nesting too deep, to judge. Callers fail closed. */
class ExpansionOverflow extends Error {}

/**
 * Every text a path argument could expand to, judged statically and failing
 * closed. A variable assigned on the line may be any of its values; `$HOME`
 * always stays `$HOME` too (a reassigned HOME never loosens a match); any
 * other unknown variable stays as `$NAME` AND may be empty, unless
 * `${NAME:?}` forbids the empty case. `${A:-w}` and `${A:=w}` may be either
 * side; `${A:+w}` is empty or w. Only the text after a reference is re-scanned,
 * so a `$NAME` placeholder is never expanded twice. `depth` counts nesting
 * (a word inside `${A:-word}`), not references in sequence. Throws
 * ExpansionOverflow rather than return a partial list.
 */
function expandCandidates(
	p: string,
	vars: ReadonlyMap<string, string[] | null>,
	depth = 0,
): string[] {
	const m = VAR_REF_RE.exec(p);
	if (!m) return [p];
	// The recursion is one frame per reference: refuse a long argument up front
	// rather than let it overflow the stack (8SO M3). Counting every `$` over-counts.
	if (depth > MAX_NESTING || countDollars(p) > MAX_REFS) throw new ExpansionOverflow();
	const name = m[1] ?? m[4];
	const op = m[2] ?? "";
	const word = m[3] ?? "";
	const prefix = p.slice(0, m.index);
	const suffix = p.slice(m.index + m[0].length);
	const known = vars.get(name);
	if (known === null) throw new ExpansionOverflow();
	let values: string[];
	if (name === "HOME") values = ["$HOME", ...(known ?? [])];
	else values = known ?? [`$${name}`, ""];
	if (op === ":-" || op === "-" || op === ":=" || op === "=")
		values = [...values, ...expandCandidates(word, vars, depth + 1)];
	else if (op === ":+" || op === "+") values = ["", ...expandCandidates(word, vars, depth + 1)];
	else if (op === ":?") values = values.filter((v) => v !== "");
	const out = new Set<string>();
	const rest = expandCandidates(suffix, vars, depth);
	for (const v of values) {
		for (const s of rest) {
			out.add(prefix + v + s);
			if (out.size > MAX_CANDIDATES) throw new ExpansionOverflow();
		}
	}
	return [...out];
}

/** Home, a home top-level folder, or a system path. */
function dangerousDir(d: string): boolean {
	const t = d.length > 1 ? d.replace(/\/+$/, "") : d;
	return SYSTEM_PATH_RE.test(t) || HOME_TOP_RE.test(t) || t === HOME_DIR;
}

/** The values a `NAME=value` adds to NAME: expanded against the state before it. null = overflow. */
function assignedValues(name: string, value: string, r: Collector): string[] | null {
	const prev = r.vars.get(name);
	if (prev === null) return null;
	// Not yet assigned on this line: on a conditional line this assignment may
	// not run, so the outer value (unknown, possibly empty) stays possible.
	const before = prev ?? (r.conditional ? [`$${name}`, ""] : []);
	let added: string[];
	if (/\$\(|`|<\(/.test(value))
		added = [`$${name}`, ""]; // a command's output: unknown
	else {
		try {
			added = expandCandidates(value, r.vars);
		} catch {
			return null;
		}
	}
	const all = [...new Set([...before, ...added])];
	return all.length > MAX_CANDIDATES ? null : all;
}

/** Record same-line assignments and `cd` targets, after the segment itself is analysed. */
function trackShellState(tIn: string[], r: Collector): void {
	let skip = 0;
	while (skip < tIn.length && CONTROL.has(tIn[skip] as string)) skip++;
	const t = skip ? tIn.slice(skip) : tIn;
	if (!t.length) return;
	const declared = DECLARERS.has(t[0]);
	const words = declared ? t.slice(1).filter((w) => !w.startsWith("-")) : t;
	// `D=x` alone sets D. `D=x cmd` is a prefix assignment: the expansion in
	// cmd never sees it, so it records nothing and $D stays unknown.
	if (declared || words.every((w) => ASSIGN_RE.test(w))) {
		for (const w of words) {
			const a = ASSIGN_RE.exec(w);
			if (a) r.vars.set(a[1], assignedValues(a[1], a[2], r));
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
	const cdTarget = normPath(target.replace(/^['"]+|['"]+$/g, ""));
	if (CRED_DIR_RE.test(cdTarget)) r.credCwd = true;
	if (CRED_CONFIG_DIR_RE.test(cdTarget)) r.credCwdConfig = true;
	// A relative cd, `cd -` or a cd that fails cannot be resolved from text
	// (it may go up, through a symlink, or nowhere), so the state is kept.
	if (!/^[/~$]/.test(target)) return;
	let cands: string[];
	try {
		cands = expandCandidates(target, r.vars);
	} catch {
		return; // overflow: keep the state
	}
	if (cands.some(dangerousDir)) r.cwdDanger = true;
	else if (cands.every((c) => c.startsWith("/") && !c.includes("$"))) r.cwdDanger = false;
	// Anything else could not be resolved: keep the state (fail closed).
}

// ------------------------------------------------------------------ helpers

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const isTemp = (p: string) =>
	TEMP_RE.test(p) || /\/claude-\d+\//.test(p) || p.includes("/scratchpad");
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

/**
 * The command with heredoc bodies removed, and each body with the text before its operator.
 * `quoted`: the delimiter is quoted, so the body is literal (no expansion runs in it).
 */
export function cutHeredocs(text: string): {
	text: string;
	docs: { before: string; body: string; quoted: boolean }[];
} {
	if (!text.includes("<<")) return { text, docs: [] };
	const lines = text.split("\n");
	const out: string[] = [];
	const docs: { before: string; body: string; quoted: boolean }[] = [];
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
			docs.push({ before: ln.slice(0, m.index), body: body.join("\n"), quoted: m[1] !== "" });
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
	/** The segment follows a case-arm terminator (`;;`, `;&`, `;;&`): an arm head may start it. */
	arm?: boolean;
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
	let arm = false;
	const push = (nextPiped: boolean, term = false) => {
		segs.push({ text: cur, piped, arm });
		// A blank piece (a newline after `;;`) keeps the arm start; any text ends it.
		if (cur.trim() !== "" || term) arm = term;
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
		if (ch === ";" && (s[i + 1] === ";" || s[i + 1] === "&")) {
			push(false, true);
			i += s.startsWith(";;&", i) ? 3 : 2;
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
	segs.push({ text: cur, piped, arm });
	return {
		segs: segs
			.map((x) => ({ text: x.text.trim(), piped: x.piped, arm: x.arm }))
			.filter((x) => x.text),
		subs,
	};
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
	if (CRED_TEXT_RE.test(code)) r.d("credential_file_read");
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
		const hits = (p: string) =>
			SYSTEM_PATH_RE.test(p) ||
			HOME_TOP_RE.test(p) ||
			(r.cwdDanger && p !== "" && CWD_TARGET_RE.test(p));
		// Each path as written, and every text it could expand to (#3314).
		// Any failure to expand (overflow, or anything else) is a block: fail
		// closed, and never rethrow, which would abort the rest of the analysis.
		const expandHits = (p: string) => {
			try {
				return expandCandidates(p, r.vars).some(hits);
			} catch {
				return true;
			}
		};
		const catastrophic =
			args.includes("--no-preserve-root") || paths.some((p) => hits(p) || expandHits(p));
		r.d("rm_recursive", catastrophic);
	} else if (!(paths.length && paths.every(isTemp))) {
		r.d("rm_non_temp");
	}
}

function ruleGit(args: string[], r: Collector): void {
	let k = 0;
	while (k < args.length && (args[k] as string).startsWith("-"))
		k +=
			["-C", "-c", "--git-dir", "--work-tree"].includes(args[k] as string) && args.length - k > 1
				? 2
				: 1;
	const a = args.slice(k);
	if (!a.length) return;
	const [sub, ...rest] = a;
	if (sub === "push") {
		if (
			hasFlag(rest, "f", [
				"--force",
				"--force-with-lease",
				"--force-if-includes",
				"--mirror",
				"--delete",
				"--prune",
			]) ||
			positional(rest).some((x) => x.startsWith("+") || (x.startsWith(":") && x.length > 1)) ||
			hasFlag(rest, "d")
		)
			r.d("git_push_force_or_delete");
	} else if (sub === "reset") {
		if (rest.includes("--hard") || rest.includes("--merge") || rest.includes("--keep"))
			r.d("git_reset_hard");
	} else if (sub === "clean") {
		if (!hasFlag(rest, "n", ["--dry-run"]) && hasFlag(rest, "fx", ["--force"]))
			r.d("git_clean_force");
	} else if (sub === "checkout") {
		if (rest.includes("--") || rest.includes(".") || hasFlag(rest, "f", ["--force"]))
			r.d("git_checkout_discards_changes");
	} else if (sub === "restore") {
		const stagedOnly =
			(rest.includes("--staged") || rest.includes("-S")) &&
			!rest.includes("--worktree") &&
			!rest.includes("-W");
		if (!stagedOnly) r.d("git_restore_discards_changes");
	} else if (sub === "stash") {
		if (rest[0] === "drop" || rest[0] === "clear") r.d("git_stash_drop_clear");
	} else if (sub === "branch") {
		if (
			rest.includes("-D") ||
			(rest.includes("--delete") && rest.includes("--force")) ||
			rest.includes("-df")
		)
			r.d("git_branch_force_delete");
	} else if (sub === "filter-branch" || sub === "filter-repo") {
		r.d("git_history_rewrite");
	} else if (sub === "update-ref") {
		if (rest.includes("-d")) r.d("git_update_ref_delete");
	} else if (sub === "worktree") {
		if (rest[0] === "remove" && hasFlag(rest.slice(1), "f", ["--force"]))
			r.d("git_worktree_remove_force");
	} else if (sub === "reflog") {
		if (rest[0] === "expire" || rest[0] === "delete") r.d("git_reflog_expire");
	} else if (sub === "switch") {
		if (hasFlag(rest, "fC", ["--force", "--discard-changes", "--force-create"]))
			r.d("git_switch_discards_changes");
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
	if (
		(["delete", "remove", "rm", "unarchive"].includes(act) && GH_DELETE.test(g)) ||
		(g === "repo" && act === "archive")
	)
		r.d("gh_delete");
}

function ruleDocker(args: string[], r: Collector): void {
	const j = positional(args).slice(0, 3).join(" ");
	if (
		/^((volume (rm|prune|remove))|(system prune)|(builder prune)|(compose .*down))/.test(j) &&
		(!j.startsWith("compose") || hasFlag(args, "v", ["--volumes"]))
	)
		r.d("docker_volume_rm_or_prune");
}

function ruleNpx(args: string[], r: Collector): void {
	const a = args.filter(
		(x) => !["-y", "--yes", "-q", "--quiet"].includes(x) && !x.startsWith("--package"),
	);
	if (!a.length) return;
	let tool = a[0].replace(/@[\d.^~<>=*x-]+$|@latest$/, "");
	if (tool.startsWith("@") && tool.split("/").length === 2 && tool !== "@biomejs/biome")
		tool = tool.split("/")[1];
	const rest = a.slice(1);
	const pos = positional(rest);
	if (tool === "convex") {
		const s = pos[0] ?? "";
		if (
			(s === "import" && rest.includes("--replace")) ||
			(s === "data" && rest.includes("--delete")) ||
			(s === "deployments" && pos.includes("delete"))
		)
			r.d("convex_replace_or_delete");
		else if (s === "env" && (pos[1] === "remove" || pos[1] === "rm")) r.d("convex_env_remove");
	} else if (tool === "vercel") ruleVercel(rest, r);
	else if (tool === "wrangler") ruleWrangler(rest, r);
}

function ruleVercel(args: string[], r: Collector): void {
	const pos = positional(args);
	const s = pos[0] ?? "";
	const s2 = pos[1] ?? "";
	const groups = [
		"env",
		"domains",
		"alias",
		"dns",
		"certs",
		"secrets",
		"project",
		"projects",
		"teams",
		"blob",
		"integration",
	];
	if (s === "rm" || s === "remove" || ((s2 === "rm" || s2 === "remove") && groups.includes(s)))
		r.d("vercel_remove");
}

function ruleFly(args: string[], r: Collector): void {
	const pos = positional(args);
	const s = pos[0] ?? "";
	const s2 = pos[1] ?? "";
	const groups = [
		"apps",
		"app",
		"volumes",
		"volume",
		"machine",
		"machines",
		"m",
		"secrets",
		"ips",
		"certs",
		"postgres",
		"redis",
		"tokens",
		"ext",
	];
	if (
		s === "destroy" ||
		(["destroy", "delete", "remove", "rm", "unset", "release"].includes(s2) &&
			groups.includes(s)) ||
		(s === "secrets" && s2 === "unset")
	)
		r.d("fly_destroy_or_unset");
}

function ruleWrangler(args: string[], r: Collector): void {
	if (
		positional(args)
			.slice(0, 3)
			.some((p) => ["delete", "rm", "remove", "purge"].includes(p))
	)
		r.d("wrangler_delete");
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
	if (
		/\b(delete|destroy|terminate-instances|rb|rm|remove|purge|drop|reset|uninstall|apps:destroy|sites:delete|down|unset|wipe|deleteall|delete-\w+|flushall)\b/i.test(
			args.join(" "),
		)
	)
		r.d(`cloud_delete:${b}`);
}

function ruleChmod(b: string, args: string[], r: Collector): void {
	const targets = positional(args).slice(1);
	if (targets.some((t) => SYSTEM_PATH_RE.test(t))) r.d(`${b}_system_path`);
}

function ruleKill(b: string, args: string[], r: Collector): void {
	const j = args.join(" ");
	const last = args[args.length - 1];
	if (
		b === "kill" &&
		!j.includes("$(") &&
		!j.includes("`") &&
		(last === "1" || last === "-1" || /(^|\s)-(9|KILL|SIGKILL)\s+(-1|1)$/.test(j))
	)
		r.d("kill_all_or_launchd");
	else if (
		(b === "killall" || b === "pkill") &&
		/\b(WindowServer|loginwindow|launchd|kernel_task|securityd|opendirectoryd|coreservicesd)\b/.test(
			j,
		)
	)
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
	if (seg.includes("<")) {
		const m = maskQuotes(seg);
		for (const mm of m.matchAll(/(?<!<)<(?![<(])\s*([^\s<>|;&]+)/g)) {
			const len = (mm[1] as string).length;
			const start = (mm.index ?? 0) + mm[0].length - len;
			if (credKind(seg.slice(start, start + len), r.credCwd) === "file") {
				r.d("credential_file_read");
				r.secretRead = true;
			}
		}
	}
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

/** `wrappers` false: drop only leading assignments, control words and `(`/`{`, keep env, sudo, ... */
function stripWrappers(tIn: string[], wrappers = true): string[] {
	// An index into tIn, never a slice per word: a long run of control words or `(` stays linear.
	let i = 0;
	let head: string | null = null; // replaces tIn[i] after a leading `(` or `{` is removed
	const len = () => tIn.length - i;
	const at = () => head ?? (tIn[i] as string);
	const drop = (n = 1) => {
		i += n;
		head = null;
	};
	const rest = () => {
		const out = tIn.slice(i);
		if (head !== null && out.length) out[0] = head;
		return out;
	};
	let changed = true;
	while (len() > 0 && changed) {
		changed = false;
		while (len() > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(at())) {
			drop();
			changed = true;
		}
		while (len() > 0 && CONTROL.has(at())) {
			if (at() === "for" || at() === "select" || at() === "case") return [];
			drop();
			changed = true;
		}
		if (len() > 0) {
			const stripped = at().replace(/^[({]+/, "");
			if (stripped !== at() && stripped) {
				head = stripped;
				changed = true;
			}
		}
		if (wrappers && len() > 0 && WRAPPERS.has(at())) {
			const w = at();
			drop();
			if (w === "command" && (at() === "-v" || at() === "-V")) {
				drop();
				return ["which", ...rest()];
			}
			if ((w === "timeout" || w === "gtimeout") && len() > 0) {
				while (len() > 0 && at().startsWith("-")) drop();
				drop();
			} else if (w === "nice") {
				while (len() > 0 && at().startsWith("-")) drop(at() === "-n" ? 2 : 1);
			} else if (w === "sudo" || w === "doas") {
				while (len() > 0 && at().startsWith("-"))
					drop(["-u", "-g", "-C", "-p"].includes(at()) ? 2 : 1);
			} else if (["env", "caffeinate", "arch", "stdbuf"].includes(w)) {
				while (len() > 0 && at().startsWith("-"))
					drop(["-u", "-C", "-S", "-t", "-w"].includes(at()) ? 2 : 1);
			}
			changed = true;
		}
	}
	return rest();
}

function analyseTokens(
	tIn: string[],
	piped: boolean,
	prevBin: string | null,
	r: Collector,
	depth: number,
	/** Leading `xargs` words already unwrapped: a chain of them is bounded, not recursed without limit. */
	xargsDepth = 0,
): string | null {
	const t = stripWrappers(tIn);
	if (!t.length) return null;
	const b = t[0].startsWith("$") ? t[0] : basename(t[0]);
	const args = t.slice(1);
	if (b.startsWith("$") || b.startsWith("<")) return b;

	if (b === "xargs") {
		let k = 0;
		while (k < args.length && (args[k] as string).startsWith("-"))
			k += ["-n", "-I", "-P", "-L", "-d", "-s", "-E", "-J"].includes(args[k] as string) ? 2 : 1;
		const a = args.slice(k);
		if (a.length && xargsDepth >= MAX_XARGS_CHAIN) {
			r.d("nesting_too_deep");
			return b;
		}
		return a.length ? analyseTokens(a, piped, prevBin, r, depth, xargsDepth + 1) : "xargs";
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
		let k = 0;
		while (k < args.length) {
			if ((args[k] as string).startsWith("-")) {
				k += /^-[bcDEeFIiJLlmOopQRSWw]$/.test(args[k] as string) ? 2 : 1;
				continue;
			}
			k++; // host
			break;
		}
		const a = args.slice(k);
		if (a.length) analyse(a.join(" "), r, depth + 1);
		return b;
	}
	if (INTERPRETERS.has(b) && b !== "bun") {
		if (args.some((a) => credKind(a, r.credCwd) === "file")) {
			r.d("credential_file_read");
			r.secretRead = true;
		}
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

	if (
		(b === "scp" || b === "rsync" || b === "sftp") &&
		args.some(isRemoteSpec) &&
		args.some((a) => credKind(a, r.credCwd) !== null)
	)
		r.d("secret_to_network");
	if (PACKERS.has(b) && args.some((a) => credKind(a, r.credCwd) !== null)) r.secretRead = true;
	if (b === "cp" && args.some((a) => credKind(a, r.credCwd) !== null)) r.d("credential_file_read");
	if (
		b === "dd" &&
		args.some((a) => a.startsWith("if=") && credKind(a.slice(3), r.credCwd) === "file")
	) {
		r.d("credential_file_read");
		r.secretRead = true;
	}

	if (b === "rm" || b === "rmdir") ruleRm(b, args, r);
	else if (b === "unlink") r.d("unlink");
	else if (b === "dd") {
		const of = args.find((a) => a.startsWith("of=") && !isTemp(a.slice(3)));
		if (of) r.d("dd_of", of.slice(3).startsWith("/dev/"));
	} else if (DESTRUCTIVE_ALWAYS.has(b) || b.startsWith("mkfs") || b.startsWith("newfs"))
		r.d("disk_format_or_wipe");
	else if (b === "truncate") r.d("truncate_file");
	else if (b === "git") ruleGit(args, r);
	else if (b === "gh") ruleGh(args, r);
	else if (b === "docker" || b === "docker-compose" || b === "podman")
		ruleDocker(b === "docker-compose" ? ["compose", ...args] : args, r);
	else if (NET_FETCHERS.has(b)) {
		if (/(-X|--request)\s*=?\s*DELETE/.test(args.join(" "))) r.d("http_delete");
	} else if (
		["npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "brew", "cargo", "go", "make"].includes(b)
	)
		rulePkg(b, args, r);
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
		if (
			args.includes("-delete") ||
			/-exec(dir)?\s+(rm|unlink|shred|truncate)\b/.test(j) ||
			/-exec(dir)?\s+\S*sh\s+-c\s+.*\brm\b/.test(j)
		)
			r.d("find_delete");
		else {
			const idx = args.findIndex((a) => a === "-exec" || a === "-execdir" || a === "-ok");
			if (idx >= 0) {
				const inner = args.slice(idx + 1).filter((a) => ![";", "+", "\\;", "{}"].includes(a));
				if (depth + 1 > MAX_DEPTH) r.d("nesting_too_deep");
				else analyseTokens(inner, false, null, r, depth + 1);
			}
		}
	} else if (["cp", "mv", "ditto", "install"].includes(b)) {
		const pos = positional(args);
		const dest = pos[pos.length - 1] ?? "";
		const safeCase =
			(b === "cp" && dest && isTemp(dest)) ||
			(b === "mv" && dest.includes("/.Trash")) ||
			(b === "cp" && !hasFlag(args, "f", ["--force"]) && dest.endsWith("/"));
		if (!safeCase && (SENSITIVE_FILE_RE.test(dest) || pos.some((p) => SYSTEM_PATH_RE.test(p))))
			r.d(`${b}_overwrites_sensitive_or_system`);
		if (b === "cp" && pos.length === 2 && pos[0] === "/dev/null" && dest && !isTemp(dest)) {
			r.d("empty_write_truncation");
			if (MANIFEST_RE.test(dest)) r.d("overwrite_project_manifest");
			if (DOTFILE_EXTRA_RE.test(dest)) r.d("truncate_dotfile");
		}
	} else if (b === "tee") {
		const files = positional(args);
		const truncating = !hasFlag(args, "a", ["--append"]);
		if (
			files.length &&
			!files.every(isTemp) &&
			files.some((f) => SENSITIVE_FILE_RE.test(f)) &&
			truncating
		)
			r.d("truncate_sensitive_file");
		if (truncating && files.some((f) => !isTemp(f) && MANIFEST_RE.test(f)))
			r.d("overwrite_project_manifest");
		if (truncating && files.some((f) => !isTemp(f) && DOTFILE_EXTRA_RE.test(f)))
			r.d("truncate_dotfile");
	} else if (b === "launchctl") {
		if (["bootout", "unload", "remove", "disable"].includes(positional(args)[0] ?? ""))
			r.d("launchctl_bootout_unload");
		if (["reboot", "halt", "shutdown"].includes(positional(args)[0] ?? ""))
			r.d("system_shutdown_or_reboot");
	} else if (b === "pmset") {
		if (positional(args).includes("sleepnow")) r.d("system_shutdown_or_reboot");
	} else if (b === "crontab") {
		if (args.includes("-r")) r.d("crontab_remove");
	} else if (b === "defaults") {
		if (positional(args)[0] === "delete") r.d("defaults_delete");
	} else if (b === "security") {
		const sub = positional(args)[0] ?? "";
		if (sub.startsWith("delete")) r.d("keychain_delete");
		else if (sub === "dump-keychain" || sub === "export") r.d("keychain_dump");
		else if (/^find-(generic|internet)-password$/.test(sub) && hasFlag(args, "w", ["--w"]))
			r.d("keychain_read_secret");
		else if (/^find-(generic|internet)-password$/.test(sub) && hasFlag(args, "g", []))
			r.d("keychain_read_secret");
	} else if (SHUTDOWN_BINS.has(b)) {
		r.d("system_shutdown_or_reboot");
	} else if (b === "init" || b === "telinit") {
		if (positional(args).some((a) => a === "0" || a === "6")) r.d("system_shutdown_or_reboot");
	} else if (b === "systemctl") {
		if (positional(args).some((a) => ["poweroff", "reboot", "halt", "kexec"].includes(a)))
			r.d("system_shutdown_or_reboot");
	} else if (b === "gpg" || b === "gpg2") {
		if (args.some((a) => a.startsWith("--export-sec"))) r.d("gpg_export_secret_keys");
	} else if (CRED_READERS.has(b)) {
		const dirs = DIR_READERS.has(b);
		const hit = args.some((a) => {
			const k = credKind(a, r.credCwd);
			return k === "file" || (k === "dir" && dirs);
		});
		const named = (a: string) => {
			const n = a.replace(/^\.\//, "");
			return CRED_NAME_RE.test(n) || (r.credCwdConfig && /^config(\.json)?$/.test(n));
		};
		if (hit || (r.credCwd && args.some(named))) {
			r.d("credential_file_read");
			r.secretRead = true;
		}
	} else if (b === "diskutil") {
		const s = positional(args)[0] ?? "";
		if (
			s.startsWith("erase") ||
			["zeroDisk", "randomDisk", "secureErase", "partitionDisk", "reformat"].includes(s) ||
			/apfs\s+(delete\w+|eraseVolume)/.test(args.join(" "))
		)
			r.d("diskutil_erase");
	} else if (b === "tmutil") {
		if (
			["delete", "disable", "deletelocalsnapshots", "thinlocalsnapshots"].includes(
				positional(args)[0] ?? "",
			)
		)
			r.d("tmutil_delete");
	} else if (b === "csrutil" || b === "spctl" || b === "nvram") {
		if (/disable|--master-disable|-c\b|-d\b|clear/.test(args.join(" ")))
			r.d(`${b}_disable_or_clear`);
	} else if (DB_CLIENTS.has(b)) sqlScan(args.join(" "), r);
	else if (b === "rsync") {
		if (/--delete\b|--delete-\w+|--remove-source-files/.test(args.join(" "))) r.d("rsync_delete");
	} else if (b === "zip") {
		// -m / --move deletes the inputs once archived, also inside a short
		// cluster (-qm, -rm). Lowercase only: -MM is "must match".
		if (args.some((a) => a === "--move" || /^-[A-Za-z0-9]*m[A-Za-z0-9]*$/.test(a)))
			r.d("archive_removes_source");
	} else if (b === "tar" || b === "gtar" || b === "bsdtar") {
		if (args.some((a) => a === "--remove-files")) r.d("archive_removes_source");
	} else if (b === "7z" || b === "7za" || b === "7zr" || b === "7zz") {
		if (args.some((a) => a === "-sdel")) r.d("archive_removes_source");
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
	if (CONDITIONAL_RE.test(maskQuotes(body))) r.conditional = true;
	if (REMOTE_EXEC_RE.test(view)) r.d("remote_code_substituted_into_shell");
	if (hasForkBomb(view)) r.d("fork_bomb");
	if (hasSecretRead(view)) r.secretRead = true;
	if (hasNetSink(view) || PIPE_TO_SSH.test(view)) r.netSink = true;

	for (const { before, body: doc } of docs) {
		const segs = splitSegments(before).segs;
		const last = segs[segs.length - 1];
		const t = last ? stripWrappers(tokens(stripRedirects(last.text))) : [];
		const consumer = t.length ? basename(t[0]) : null;
		if (consumer && (SHELLS.has(consumer) || consumer === "ssh")) analyse(doc, r, depth + 1);
		else if (consumer && INTERPRETERS.has(consumer)) codeScan(doc, r, "heredoc");
		else if (consumer && DB_CLIENTS.has(consumer)) sqlScan(doc, r);
		// An sftp script that puts a credential folder: its own check, not part of the chain above.
		if (consumer === "sftp" && doc.includes("put") && CRED_DIR_TEXT_RE.test(doc))
			r.d("secret_to_network");
		// cat/tee/etc: the body is file content; the redirect on the line is checked below.
	}
	const { segs, subs } = splitSegments(body);
	let prev: string | null = null;
	for (const { text: seg, piped } of segs) {
		ruleRedirects(seg, r);
		const t = tokens(stripRedirects(seg));
		if (seg.includes("put") && seg.includes("sftp") && CRED_DIR_TEXT_RE.test(seg)) {
			const w = stripWrappers(t);
			if (w.length && basename(w[0]) === "sftp") r.d("secret_to_network");
		}
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

/** One simple command as `simpleCommands` lists it. */
export interface SimpleCommand {
	/** The argv after redirects and wrappers (env, timeout, nohup, exec, ...) are removed. */
	argv: string[];
	/** The argv after redirects, leading assignments and control words; wrappers kept. */
	raw: string[];
	/** Stdin comes from a pipe or a `<` file. */
	stdin: boolean;
	/** The command has a `<<<` here-string. */
	hereString: boolean;
	/** The command has a `<(...)` or `>(...)` process substitution. */
	procSub: boolean;
	/** The segment has text no argv could be read from (an unparsed shape); callers fail closed. */
	opaque?: boolean;
}

const LEAD_KW = "(?:(?:then|do|else|elif|if|while|until|!|time)\\s+)*";
const CASE_HEAD = new RegExp(`^\\s*${LEAD_KW}case\\s+(?:'[^']*'|"[^"]*"|[^\\s'"]+)\\s+in\\b\\s*`);
const CASE_PAT = "(?:'[^']*'|\"[^\"]*\"|[^\\s()'\"|;&]+)";
const CASE_ARM = new RegExp(`^\\s*\\(?\\s*${CASE_PAT}(?:\\s*\\|\\s*${CASE_PAT})*\\s*\\)\\s*`);
const CASE_ALT = new RegExp(`^\\s*\\(?\\s*${CASE_PAT}\\s*$`);
const LEAD_KW_RE = new RegExp(`^\\s*${LEAD_KW}`);
/**
 * What `case` text a segment held, and the text left once it is accounted for. An arm head
 * `PAT)` is stripped only at an arm start (`armStart`): right after `case WORD in`, after a
 * `;;` `;&` `;;&` terminator, or after an `a|` pattern alternative. Never mid-arm, never on a
 * bare leading `(` elsewhere.
 */
function peelCase(
	seg: string,
	inCase: number,
	armStart: boolean,
): {
	text: string;
	inCase: number;
	explained: boolean;
	armNext: boolean;
	pattern: boolean;
	head: boolean;
} {
	let t = seg;
	let n = inCase;
	let explained = false;
	let start = armStart;
	const head = CASE_HEAD.exec(t);
	if (head) {
		t = t.slice(head[0].length);
		n++;
		explained = true;
		start = true;
	}
	const armNext = head !== null && t.trim() === "";
	let pattern = false;
	if (n > 0 && start) {
		const arm = CASE_ARM.exec(t);
		if (arm) {
			t = t.slice(arm[0].length);
			explained = true;
		} else if (CASE_ALT.test(t)) {
			pattern = true; // `a` of `a|x)`: the rest follows in the next, piped, segment
			explained = true;
		}
	}
	if (/^\s*esac\b/.test(t) && n > 0) n--;
	return { text: t, inCase: n, explained, armNext, pattern, head: head !== null };
}
/** The inside of a leading `( ... )` subshell or `{ ...; }` group, or null when there is none. */
function groupInside(seg: string): string | null {
	const t = seg.replace(LEAD_KW_RE, "").trim();
	if (/^\(\(/.test(t)) return null; // `(( ... ))` is arithmetic, read elsewhere
	if (t.startsWith("(")) return t.replace(/^\(\s*/, "").replace(/\)\s*$/, "");
	if (/^\{\s/.test(t)) return t.replace(/^\{\s*/, "").replace(/\}\s*$/, "");
	return null;
}
/**
 * Constructs this reader does not model, so a segment holding one is never "read": a `case`
 * (arm parsing here is informational only), a function definition, `alias`, and `shopt`/`setopt`
 * naming extglob or kshglob (which change what a pattern or word means). Fail closed.
 */
const FUNC_DEF = /^\s*(?:function\s+\S|[A-Za-z_][\w.:+-]*\s*\(\s*\))/;
const GLOB_MODE = /^\s*(?:shopt|setopt)\b.*(?:extglob|ksh_?glob)/i;
function unmodelled(seg: string, head: boolean): boolean {
	if (head || FUNC_DEF.test(seg) || GLOB_MODE.test(seg)) return true;
	const w = seg.replace(LEAD_KW_RE, "").trim().split(/\s+/)[0] ?? "";
	return w === "alias" || w === "case";
}
const KEYWORDS_ONE = new Set([...CONTROL, ":", "true", "false"]);
/** True when `name` resolves to an executable on the real PATH; unknown (no Bun) counts as no. */
function onPath(name: string): boolean {
	try {
		return typeof Bun !== "undefined" && Bun.which(name) !== null;
	} catch {
		return false;
	}
}
const OPAQUE_OK = new Set([...CONTROL].filter((w) => w !== "case"));
/** True when `t` is only keywords, assignments, or a `for`/`select` header: nothing to launch. */
function bareKeywords(t: string[]): boolean {
	return (
		t.every((w) => OPAQUE_OK.has(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ||
		t[0] === "for" ||
		t[0] === "select"
	);
}

/**
 * Every simple command in `text` as the rules read it (see `SimpleCommand`). A heredoc fed to a
 * shell, and every $(...) and backtick body, are listed as commands of their own. Used to find
 * the script files a command runs (packages/permissions/s1-script-body.ts). Throws when nesting
 * is too deep; the caller fails closed.
 */
export function simpleCommands(text: string, depth = 0): SimpleCommand[] {
	if (depth > MAX_DEPTH) throw new Error("nesting too deep");
	const { text: body, docs } = cutHeredocs(text);
	const out: SimpleCommand[] = [];
	for (const { before, body: doc } of docs) {
		const segs = splitSegments(before).segs;
		const last = segs[segs.length - 1];
		const t = last ? stripWrappers(tokens(stripRedirects(last.text))) : [];
		// `{ bash; } <<X` and `(bash) <<X`: the group's closer is last, its shell is earlier.
		const grouped = last !== undefined && /[)}]$/.test(last.text.trim());
		const feedsShell = grouped
			? simpleCommands(before, depth + 1).some(
					(c) => c.argv.length > 0 && SHELLS.has(basename(c.argv[0])),
				)
			: t.length > 0 && SHELLS.has(basename(t[0]));
		if (feedsShell) out.push(...simpleCommands(doc, depth + 1));
	}
	const { segs, subs } = splitSegments(body);
	let inCase = 0;
	let armNext = false;
	let patPending = false;
	for (const { text: seg, piped, arm } of segs) {
		const peeled = peelCase(seg, inCase, !!arm || armNext || (patPending && piped));
		inCase = peeled.inCase;
		armNext = peeled.armNext;
		patPending = peeled.pattern;
		if (unmodelled(seg, peeled.head)) {
			out.push({
				argv: [],
				raw: [],
				stdin: piped,
				hereString: false,
				procSub: false,
				opaque: true,
			});
			continue;
		}
		if (peeled.pattern) continue;
		// A leading subshell or group is its own command list: judge what is inside it.
		const inner = groupInside(peeled.text);
		if (inner !== null) {
			// A one-word subshell is a PATH lookup: unless it resolves to a real binary, fail closed.
			// Top level only: a `$((x))` arithmetic body reaches here as `(x)` one level down.
			const one = inner.trim();
			if (
				depth === 0 &&
				/^[A-Za-z_.][A-Za-z0-9_.-]*$/.test(one) &&
				!KEYWORDS_ONE.has(one) &&
				!onPath(one)
			)
				out.push({
					argv: [one],
					raw: [one],
					stdin: piped,
					hereString: false,
					procSub: false,
					opaque: true,
				});
			for (const c of simpleCommands(inner, depth + 1)) out.push({ ...c, stdin: c.stdin || piped });
			continue;
		}
		const masked = maskQuotes(seg);
		const fromFile = /(^|[^<\d])\d?<(?![<(&])/.test(masked);
		const t = tokens(stripRedirects(peeled.text));
		const argv = stripWrappers(t);
		// Opaque: no argv, and the text is not wholly keywords, assignments or a case head/arm.
		const blank = peeled.text.trim() === "";
		out.push({
			argv,
			raw: stripWrappers(t, false),
			stdin: piped || fromFile,
			hereString: masked.includes("<<<"),
			procSub: /[<>]\(/.test(masked),
			// Backstop: no argv, or a word shaped like an arm head left standing inside a case.
			opaque:
				(argv.length === 0 && !blank && !bareKeywords(t)) ||
				(inCase > 0 && /^\(?[^\s()$`]*\)$/.test(argv[0] ?? "")),
		});
	}
	for (const s of subs) out.push(...simpleCommands(s, depth + 1));
	return out;
}
