/**
 * @8gent/voice - Termux (Android) backends (#4706).
 *
 * On Termux, sox has no usable microphone, so recording goes through the
 * Termux:API app (`termux-microphone-record`) and speech through
 * `termux-tts-speak`. Pure helpers live here so the recorder, the TTS engine,
 * the transcriber and /voice status share one rule and tests can feed them a
 * fake PATH and a platform.
 *
 * Facts checked against the Termux repo (termux-main, aarch64, 21 Oct 2026):
 * termux-api, sox, ffmpeg and mpv are packages; whisper-cpp is NOT, and neither
 * is a bare `yt-dlp` (the package is python-yt-dlp, which ships bin/yt-dlp).
 * termux-microphone-record can only encode aac, amr_wb or amr_nb, never WAV,
 * so a recording is converted to 16 kHz mono WAV with ffmpeg.
 */

import { constants, accessSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

type Env = Record<string, string | undefined>;

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

/** First executable named `name` on env.PATH, or null. Synchronous so status lines stay cheap. */
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

/** The exact fix for each missing piece. One line each, copy-pasteable. */
export const TERMUX_FIX = {
	mic: "install the Termux:API app from F-Droid, then run: pkg install termux-api",
	tts: "install the Termux:API app from F-Droid, then run: pkg install termux-api",
	ffmpeg: "pkg install ffmpeg",
	whisper:
		"whisper-cpp is not in the Termux repo; use cloud transcription: export OPENAI_API_KEY=...",
	cloudKey: "export OPENAI_API_KEY=... (or run: 8gent keys set openai)",
} as const;

export const TERMUX_MIC_MISSING = `termux-microphone-record not found: ${TERMUX_FIX.mic}`;
export const TERMUX_FFMPEG_MISSING = `ffmpeg not found (converts the Termux recording to WAV): ${TERMUX_FIX.ffmpeg}`;

export function termuxRecordArgs(path: string, seconds: number): string[] {
	// -e aac: the encoder Android's MediaRecorder always has. -l 0 would mean no limit; we always cap.
	return [
		"-f",
		path,
		"-e",
		"aac",
		"-r",
		"16000",
		"-c",
		"1",
		"-l",
		String(Math.max(1, Math.ceil(seconds))),
	];
}

export const TERMUX_STOP_ARGS = ["-q"];

export function ffmpegToWavArgs(src: string, dst: string): string[] {
	return [
		"-y",
		"-loglevel",
		"error",
		"-i",
		src,
		"-ar",
		"16000",
		"-ac",
		"1",
		"-c:a",
		"pcm_s16le",
		dst,
	];
}

/** Run a command to completion; resolves its exit code (127 when it cannot start). */
export async function runToExit(cmd: string[], env: Env = process.env): Promise<number> {
	try {
		const proc = Bun.spawn(cmd, {
			stdout: "ignore",
			stderr: "ignore",
			env: env as Record<string, string>,
		});
		return await proc.exited;
	} catch {
		return 127;
	}
}

/** Convert a Termux recording to the 16 kHz mono WAV whisper wants. Throws with the fix when ffmpeg is missing. */
export async function convertToWav(
	src: string,
	dst: string,
	env: Env = process.env,
): Promise<void> {
	const ffmpeg = findOnPath("ffmpeg", env);
	if (!ffmpeg) throw new Error(TERMUX_FFMPEG_MISSING);
	const code = await runToExit([ffmpeg, ...ffmpegToWavArgs(src, dst)], env);
	if (code !== 0)
		throw new Error(
			`ffmpeg could not convert the recording (exit ${code}). Is the microphone permission granted to Termux:API?`,
		);
}

/**
 * Voice output is allowed only when EIGHT_VOICE=1 or the RAW settings file
 * literally has voice.outputEnabled true. Merged defaults are never read, so a
 * person who never touched voice gets silence (same rule as the System One
 * audio lane, #4713). `readSettings` is injectable for tests.
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

export interface TermuxVoiceState {
	mic: boolean;
	ffmpeg: boolean;
	tts: boolean;
	whisper: boolean;
	cloudKey: boolean;
}

export function termuxVoiceState(env: Env = process.env): TermuxVoiceState {
	return {
		mic: !!findOnPath("termux-microphone-record", env),
		ffmpeg: !!findOnPath("ffmpeg", env),
		tts: !!findOnPath("termux-tts-speak", env),
		whisper: !!(
			findOnPath("whisper-cli", env) ||
			findOnPath("whisper-cpp", env) ||
			findOnPath("whisper", env)
		),
		cloudKey: !!env.OPENAI_API_KEY,
	};
}

const dep = (ok: boolean, name: string, fix: string): string =>
	ok ? `${name}=ok` : `${name}=missing (${fix})`;

/**
 * One line for /voice status on Android, per-dependency, with the exact fix:
 * `voice: input=missing (termux-microphone-record: ...) transcribe=... output=...`.
 */
export function describeTermuxVoice(env: Env = process.env): string {
	const s = termuxVoiceState(env);
	const inputMissing = [
		!s.mic ? `termux-microphone-record: ${TERMUX_FIX.mic}` : "",
		!s.ffmpeg ? `ffmpeg: ${TERMUX_FIX.ffmpeg}` : "",
	].filter(Boolean);
	const input = inputMissing.length ? `input=missing (${inputMissing.join("; ")})` : "input=ok";
	const transcribe =
		s.whisper || s.cloudKey
			? `transcribe=ok (${s.whisper ? "whisper-cli local" : "OpenAI cloud"})`
			: `transcribe=missing (whisper-cli: ${TERMUX_FIX.whisper}; cloud key: ${TERMUX_FIX.cloudKey})`;
	const output = dep(s.tts, "output", `termux-tts-speak: ${TERMUX_FIX.tts}`);
	return `voice: ${input} ${transcribe} ${output}`;
}

/** The error when no transcriber exists on Android: names which of the two is missing. */
export function transcriberMissingMessage(): string {
	return `No transcriber on this phone. Local: whisper-cli not found (${TERMUX_FIX.whisper}). Cloud: OPENAI_API_KEY not set (${TERMUX_FIX.cloudKey}).`;
}
