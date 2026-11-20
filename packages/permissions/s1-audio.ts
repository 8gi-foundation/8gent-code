/**
 * System One audio lane (#4713): nothing speaks, plays a sound or pops a
 * notification unless the person turned voice on.
 *
 * Headless `8gent run` has no person to ask, so these commands are always
 * refused there. In the TUI they pass this lane only when voice is on: the
 * existing `voice.outputEnabled` setting, or EIGHT_VOICE=1. Passing here is
 * not an allow: the judge and the other lanes still decide.
 */

export const AUDIO_REFUSAL =
	"Audio is off for this session; say nothing aloud unless the person turns voice on.";

const AUDIO_PROGRAMS = new Set([
	"say",
	"afplay",
	"termux-tts-speak",
	"espeak",
	"espeak-ng",
	"paplay",
	"spd-say",
	"aplay",
	"ffplay",
	"mpg123",
	"pw-play",
	"notify-send",
	"terminal-notifier",
]);

const AUDIO_FILE = /\.(aiff|wav|mp3|m4a|ogg|flac)\b/i;
/** An osascript is plainly read-only only when it is a `-e` get/return with none of these. */
const OSA_LOUD =
	/beep|say\b|speak|notification|play|sound|do shell|run script|activate|keystroke|click|\bset\b|make\b|delete|quit|launch|open/i;
const SHELL_WORD = /(^|[|;&]\s*)(sudo\s+)?(sh|bash|zsh|dash|ksh|eval|source|\.)(\s|$)/;

const BARE_NAME = new RegExp(
	`(?<![A-Za-z0-9_.-])(?:${[...AUDIO_PROGRAMS].sort((a, b) => b.length - a.length).join("|")})(?![A-Za-z0-9_.-])`,
);

const WRAPPERS = new Set([
	"env",
	"nohup",
	"command",
	"time",
	"sudo",
	"exec",
	"xargs",
	"busybox",
	"nice",
	"timeout",
	"stdbuf",
	"setsid",
	"builtin",
]);
/** Shell keywords that start a command: `then say hi`, `do afplay x`, `{ say hi`, `! say`. */
const KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "{", "!", "time"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** Wrapper flags that take a value as the next word. */
const FLAG_WITH_VALUE = new Set(["-u", "-g", "-h", "-p", "-C", "-I", "-n", "-P", "-s", "-S"]);

/**
 * A word that looks like a command name or path: the pieces of a quote-blind split do not.
 * `!` and `^` negate a glob class (`s[!x]y`, `s[^x]y`), 8SO #303. A POSIX class (`[:alpha:]`)
 * is folded first, so a bare `:` (a Python slice `h[0:2]`) still reads as not a name.
 */
const NAMEISH_CHARS = /^[A-Za-z\/.~{[][A-Za-z0-9_.\/{}[\]*?,~!^-]*$/;
const NAMEISH = {
	test: (w: string): boolean => NAMEISH_CHARS.test(w.replace(/\[([:=.])\w*\1\]/g, "a")),
};

const BELL = /\\(a|0?07|x0?7|u0{0,3}7|U0{0,7}7)/;

/** Decode `$'\x73ay'` style quoting, then drop quotes and backslashes: what the shell would call. */
function unquoteWord(w: string): string {
	const decoded = w.replace(/\$'((?:[^'\\]|\\.)*)'/g, (_m, body: string) =>
		body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|[0-7]{1,3}|.)/g, (_e, c: string) => {
			if (c[0] === "x" && c.length > 1) return String.fromCharCode(Number.parseInt(c.slice(1), 16));
			if (c[0] === "u" && c.length > 1) return String.fromCharCode(Number.parseInt(c.slice(1), 16));
			if (/^[0-7]+$/.test(c)) return String.fromCharCode(Number.parseInt(c, 8));
			return c;
		}),
	);
	return decoded.replace(/["'\\]/g, "");
}

const bare = (w: string): string => w.replace(/^["'`$(]+|["'`)]+$/g, "");
const base = (w: string): string => bare(w).replace(/^.*\//, "");

/** Interpreters whose quoted `-c`/`-e` body is that language's code, not shell words (#298). */
const CODE_INTERPRETERS = new Set(["python", "node", "bun", "deno", "ruby", "perl"]);

/**
 * Spans of each plain '...' string given as the `-c`/`-e` body of a code interpreter
 * (`python3 -c '...'`). The shell never expands inside it, so `d["train"]` there is a Python
 * subscript, not a glob command word (#298). A shell body (`bash -c '...'`) is never a span.
 * Fails closed (no spans) on a line with ANSI-C `$'...'` quoting or an unquoted `#` comment,
 * where this quote scan could pair the wrong quotes (8SO, #303).
 */
function codeBodies(command: string): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	let segStart = 0;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\") {
			i++;
		} else if (ch === '"') {
			for (i++; i < command.length && command[i] !== '"'; i++) if (command[i] === "\\") i++;
		} else if (ch === "$" && command[i + 1] === "'") {
			return [];
		} else if (ch === "#" && (i === 0 || /[\s;&|(]/.test(command[i - 1] ?? ""))) {
			return [];
		} else if (ch === "'") {
			const end = command.indexOf("'", i + 1);
			if (end < 0) break;
			const words = command.slice(segStart, i).trim().split(/\s+/);
			let k = 0;
			while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k] ?? "")) k++;
			const prog = base(words[k] ?? "").replace(/[\d.]+$/, "");
			const flag = words.length > k + 1 ? (words[words.length - 1] ?? "") : "";
			if (CODE_INTERPRETERS.has(prog) && /^-[A-Za-z]*[ce]$/.test(flag)) spans.push([i, end]);
			i = end;
		} else if (/[;&|\n(]/.test(ch ?? "")) {
			segStart = i + 1;
		}
	}
	return spans;
}

/**
 * True when a glob or brace word could expand to an audio program's name. Used inside a code
 * body, whose shell strings (os.system, execSync, system) can still reach a shell (8SO, #303).
 * A word this cannot read is treated as a match.
 */
function globNamesAudio(path: string): boolean {
	// The program is the last path component; a glob only in the folder part names that program.
	const word = path.replace(/^.*\//, "");
	let re = "";
	for (let i = 0; i < word.length; i++) {
		const c = word[i] ?? "";
		if (c === "*") re += ".*";
		else if (c === "?") re += ".";
		else if (c === "[") {
			// sh reads a ] right after [, [! or [^ as a member ([]a] is "] or a"), and [: [= [.
			// open POSIX classes: not converted, so treated as a match (8SO, #303).
			if (/^[!^]?\]/.test(word.slice(i + 1)) || /\[[:=.]/.test(word.slice(i))) return true;
			const end = word.indexOf("]", i + 2);
			if (end < 0) return true;
			re += `[${word
				.slice(i + 1, end)
				.replace(/^!/, "^")
				.replace(/\\/g, "\\\\")}]`;
			i = end;
		} else if (c === "{") {
			const end = word.indexOf("}", i);
			if (end < 0) return true;
			const body = word.slice(i + 1, end);
			// sh expands the brace first, then globs each part: a part holding a glob, a
			// nested brace or an escape is not read here, so it counts as a match (8SO, #303).
			if (/[{*?[\\]/.test(body)) return true;
			if (body.includes("..")) re += ".*";
			else
				re += `(${body
					.split(",")
					.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
					.join("|")})`;
			i = end;
		} else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	let rx: RegExp;
	try {
		rx = new RegExp(`^${re}$`);
	} catch {
		return true;
	}
	return [...AUDIO_PROGRAMS].some((name) => rx.test(name));
}

/** True when this one simple command, after unwrapping env/sudo/xargs and the like, makes sound. */
function segmentIsAudio(segment: string, command: string, inCode = false): boolean {
	const words = segment.trim().split(/\s+/).filter(Boolean);
	let i = 0;
	for (;;) {
		while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) i++;
		const w = base(words[i] ?? "");
		if (KEYWORDS.has(w)) {
			i++;
			continue;
		}
		if (!WRAPPERS.has(w)) break;
		i++;
		while (i < words.length) {
			const next = words[i] ?? "";
			if (FLAG_WITH_VALUE.has(next)) i += 2;
			else if (next.startsWith("-") || /^\d+[smhd]?$/.test(next)) i++;
			else break;
		}
	}
	// Judge the whole command word: quotes, backslashes and ANSI-C quoting are removed, then it
	// must not be an audio program, and must not still build its name from a variable.
	const word = unquoteWord(words[i] ?? "");
	// A command word that is a glob, a brace expansion or the head of a $( ) cannot be read.
	// Inside a code interpreter's quoted body (`d["train"]`) a glob counts only when it could
	// name an audio program, since the code can still hand a shell string to a shell (#298, #303).
	if (
		word === "$" ||
		/^[A-Za-z0-9_./-]+\$$/.test(word) ||
		(word !== "[" &&
			word !== "[[" &&
			NAMEISH.test(word) &&
			/[*?]|\[.+\]|\{[^}]*(,|\.\.)[^}]*\}/.test(word) &&
			(!inCode || globNamesAudio(word)))
	)
		return true;
	if (/\$[A-Za-z_{(]/.test(word)) return true;
	const prog = base(word);
	if (AUDIO_PROGRAMS.has(prog)) return true;
	if (prog === "osascript") {
		const plainlyReadOnly =
			/\s-e\s/.test(command) && /\b(get|return)\b/i.test(command) && !OSA_LOUD.test(command);
		if (!plainlyReadOnly) return true;
	}
	if ((prog === "open" || prog === "xdg-open") && AUDIO_FILE.test(segment)) return true;
	if (prog === "tput" && /\bbel\b/.test(segment)) return true;
	// The terminal bell by escape: printf '\a', echo -e '\a' (also \007, \x07).
	if (
		BELL.test(segment) &&
		(prog === "printf" ||
			(prog === "echo" && (/\s-[a-zA-Z]*e/.test(segment) || segment.includes("$'"))))
	)
		return true;
	if (SHELLS.has(prog)) {
		for (let j = i + 1; j < words.length; j++) {
			if (/^-[A-Za-z]*c[A-Za-z]*$/.test(words[j] ?? "")) {
				return isAudioCommand(
					words
						.slice(j + 1)
						.join(" ")
						.replace(/["']/g, ""),
				);
			}
		}
	}
	return false;
}

/**
 * True when any command in the line makes sound or shows a desktop notification, including
 * one wrapped in env/nohup/sudo/xargs, run by `sh -c`, or inside $( ), backticks or ( ).
 * The split is quote-blind on purpose: it can over-refuse, never under-refuse.
 */
export function isAudioCommand(command: string): boolean {
	// Command substitution as a command word: its output is run, so its name cannot be read.
	if (
		/(^|[;&|\n]|\b(?:then|do|else|env|exec|command|builtin|nohup|sudo)\s)\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:\$\(|`)/.test(
			command,
		)
	)
		return true;
	const spans = codeBodies(command);
	let at = 0;
	for (const segment of command.split(/&&|\|\||[;|&\n`()]/)) {
		const start = command.indexOf(segment, at);
		at = start + segment.length;
		const inCode = spans.some(([s, e]) => start > s && start < e);
		if (segmentIsAudio(segment, command, inCode)) return true;
	}
	// A line that names an audio program and hands text to a shell (`echo say hi | sh`).
	if (BARE_NAME.test(command) && SHELL_WORD.test(command)) return true;
	// Backstop: an audio program name as a bare word anywhere (eval, find -exec, here-strings,
	// su -c, ssh, arch, caffeinate, a variable's value). Over-refusing is accepted; a plain
	// echo/printf/grep line that only mentions the name is left alone.
	for (const segment of command.split(/&&|\|\||[;|&\n`()]/)) {
		if (/^\s*(echo|printf|grep)\s/.test(segment) && !/\s--pre(=|\s|$)/.test(segment)) continue;
		if (BARE_NAME.test(segment)) return true;
	}
	return false;
}

/** The refusal for this command, or undefined when it is not audio or voice is on in the TUI. */
export function audioRefusal(
	command: string,
	where: { tui: boolean; voiceOn: boolean },
): string | undefined {
	if (!isAudioCommand(command)) return undefined;
	if (where.tui && where.voiceOn) return undefined;
	return AUDIO_REFUSAL;
}

/**
 * Voice is on only when EIGHT_VOICE=1 or the raw settings file literally has
 * voice.outputEnabled true. The merged defaults (which say true) are never read, so a
 * person who never touched voice gets silence.
 */
export async function voiceIsOn(env: Record<string, string | undefined>): Promise<boolean> {
	if (env.EIGHT_VOICE === "1") return true;
	try {
		const { getSettingsFilePath } = await import("../settings/index.js");
		const { readFileSync } = await import("node:fs");
		const parsed = JSON.parse(readFileSync(getSettingsFilePath(), "utf8"));
		return parsed?.voice?.outputEnabled === true;
	} catch {
		return false;
	}
}
