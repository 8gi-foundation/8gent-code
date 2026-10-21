/**
 * @8gent/voice - Android / Termux helpers (#4706).
 *
 * Android phones already dictate through the keyboard's microphone key, so 8gent
 * records nothing and runs no whisper there. The only Android voice piece is
 * spoken replies through `termux-tts-speak` (Termux:API), behind the audio gate.
 *
 * Termux repo facts (termux-main aarch64, 21 Oct 2026): termux-api, mpv and
 * ffmpeg are packages; whisper-cpp is not; yt-dlp ships in `python-yt-dlp`.
 */

import { constants, accessSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

type Env = Record<string, string | undefined>;

/** The one line /voice status, /voice record and /voice chat print on Android. */
export const ANDROID_DICTATION_LINE =
	"On Android, tap the microphone key on your keyboard; dictation lands in the prompt. Spoken replies: /voice on (needs termux-tts-speak: pkg install termux-api plus the Termux:API app).";

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
