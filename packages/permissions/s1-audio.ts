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

const bare = (w: string): string => w.replace(/^["'`$(]+|["'`)]+$/g, "");
const base = (w: string): string => bare(w).replace(/^.*\//, "");

/** True when this one simple command, after unwrapping env/sudo/xargs and the like, makes sound. */
function segmentIsAudio(segment: string, command: string): boolean {
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
	// A command word built from a variable, a backslash or empty quotes hides its name. Only a
	// word that starts like a name is judged, so the pieces of a quote-blind split are left alone.
	if (/^(\\|\$)[A-Za-z_{(]|^[A-Za-z0-9_-]+(''|""|\$[A-Za-z_{(]|\\[A-Za-z])/.test(words[i] ?? ""))
		return true;
	const prog = base(words[i] ?? "");
	if (AUDIO_PROGRAMS.has(prog)) return true;
	if (prog === "osascript") {
		const plainlyReadOnly =
			/\s-e\s/.test(command) && /\b(get|return)\b/i.test(command) && !OSA_LOUD.test(command);
		if (!plainlyReadOnly) return true;
	}
	if ((prog === "open" || prog === "xdg-open") && AUDIO_FILE.test(segment)) return true;
	if (prog === "tput" && /\bbel\b/.test(segment)) return true;
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
	for (const segment of command.split(/&&|\|\||[;|&\n`()]/)) {
		if (segmentIsAudio(segment, command)) return true;
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
