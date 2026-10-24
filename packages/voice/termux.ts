/**
 * @8gent/voice - Android / Termux helpers (#4706).
 *
 * No sox there. Voice input records with termux-microphone-record and transcribes
 * on the phone with whisper.cpp (termux-local-stt.ts, #4905). Android's speech
 * service (termux-stt.ts, #4833) is used only after /voice mic cloud. Spoken
 * replies go through `termux-tts-speak` (Termux:API), behind the audio gate.
 *
 * Termux repo facts (termux-main aarch64 and TUR, 24 Oct 2026): termux-api, mpv,
 * ffmpeg, clang, cmake and make are packages; whisper-cpp is not, so it is built
 * on the phone; yt-dlp ships in `python-yt-dlp`.
 */

import { constants, accessSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

type Env = Record<string, string | undefined>;

/** The one line /voice status, /voice record and /voice chat print on Android. */
export const ANDROID_DICTATION_LINE =
	"On Android, press Ctrl+R (or /voice record) to speak, and again to stop; the text lands in the prompt. Spoken replies: /voice on (needs termux-tts-speak: pkg install termux-api plus the Termux:API app).";

/** True on Android under Termux: platform android, TERMUX_VERSION, or a com.termux PREFIX. */
export function isAndroidHost(
	platform: string = process.platform,
	env: Env = process.env,
): boolean {
	return (
		platform === "android" ||
		!!env.TERMUX_VERSION ||
		String(env.PREFIX ?? "").includes("/com.termux/")
	);
}

/** First executable named `name` on env.PATH, or null. */
export function findOnPath(name: string, env: Env = process.env): string | null {
	for (const dir of String(env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	return null;
}

/**
 * Voice output is allowed only when EIGHT_VOICE=1 or the RAW settings file
 * literally has voice.outputEnabled true. Merged defaults are never read, so a
 * person who never touched voice gets silence (same rule as #4713/#4718).
 */
export function voiceOutputOn(
	env: Env = process.env,
	readSettings: () => string = () => {
		const home = env.EIGHT_HOME || join(env.HOME ?? "", ".8gent");
		return readFileSync(join(home, "settings.json"), "utf8");
	},
): boolean {
	if (env.EIGHT_VOICE === "1") return true;
	try {
		return JSON.parse(readSettings())?.voice?.outputEnabled === true;
	} catch {
		return false;
	}
}

/** Said once when spoken replies are on but termux-tts-speak cannot run. */
export const TERMUX_TTS_HINT =
	"Spoken replies need termux-tts-speak: pkg install termux-api, plus the Termux:API app from F-Droid.";

/** What Ctrl+R does: Android records (or listens) through Termux:API, elsewhere it toggles recording. */
export function ctrlRAction(
	key: { ctrl?: boolean },
	input: string,
	android: boolean = isAndroidHost(),
): "ignore" | "toggle" | "android-listen" {
	if (!key.ctrl || input !== "r") return "ignore";
	return android ? "android-listen" : "toggle";
}

/** The line /voice status and /voice mic print on Android: the consent state, where audio goes, the switches. */
export function androidMicStateLine(on: boolean, cloud = false): string {
	if (!on) return "Voice input: off. Ctrl+R asks before it turns on.";
	return cloud
		? "Voice input: on, through Android's speech service, so audio leaves the phone. /voice mic local keeps it on the phone; /voice mic off turns it off."
		: "Voice input: on, transcribed on this phone with whisper.cpp. /voice mic cloud uses Android's speech service instead; /voice mic off turns it off.";
}

/** /voice subcommands that print the Android line instead of the desktop text. record, listen and stt listen instead. */
export const ANDROID_VOICE_LINE_SUBS = ["", "chat", "conversation", "talk", "status", "stop"];

/** /voice subcommands that listen once on Android. */
export const ANDROID_VOICE_LISTEN_SUBS = ["record", "listen", "stt"];
