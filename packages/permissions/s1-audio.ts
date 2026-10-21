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
]);

/** The program word of one simple command: env assignments and a leading path dropped. */
function programOf(segment: string): { prog: string; rest: string } {
	const words = segment.trim().split(/\s+/);
	let i = 0;
	while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) i++;
	const first = words[i] ?? "";
	const prog = first.replace(/^["']|["']$/g, "").replace(/^.*\//, "");
	return { prog, rest: words.slice(i + 1).join(" ") };
}

/** True when any command in the line makes sound or shows a desktop notification. */
export function isAudioCommand(command: string): boolean {
	for (const segment of command.split(/&&|\|\||[;|&\n]/)) {
		const { prog, rest } = programOf(segment);
		if (AUDIO_PROGRAMS.has(prog)) return true;
		if (prog === "osascript" && /display\s+notification/i.test(`${rest} ${command}`)) return true;
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

/** Voice is on when EIGHT_VOICE=1 or the saved voice.outputEnabled setting is true. */
export async function voiceIsOn(env: Record<string, string | undefined>): Promise<boolean> {
	if (env.EIGHT_VOICE === "1") return true;
	try {
		const { loadSettings } = await import("../settings/index.js");
		return loadSettings().voice?.outputEnabled === true;
	} catch {
		return false;
	}
}
