import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHint } from "../music/dj.js";
import { describeMissingVoiceSetup } from "./input-device.js";
import { MicRecorder, checkSoxInstalled } from "./recorder.js";
import {
	TERMUX_FFMPEG_MISSING,
	TERMUX_MIC_MISSING,
	describeTermuxVoice,
	findOnPath,
	isAndroidHost,
	transcriberMissingMessage,
	voiceOutputOn,
} from "./termux.js";
import { findWhisperBinary } from "./transcriber.js";
import { TTSEngine, TermuxTTSProvider } from "./tts-engine.js";

let bin: string;
const savedEnv = { ...process.env };

/** A PATH holding only the named fake executables. */
function fakePath(...names: string[]): Record<string, string> {
	for (const n of names) {
		const f = join(bin, n);
		writeFileSync(f, "#!/bin/sh\nexit 0\n");
		chmodSync(f, 0o755);
	}
	return { PATH: bin, HOME: bin };
}

beforeEach(() => {
	bin = mkdtempSync(join(tmpdir(), "termux-voice-"));
});
afterEach(() => {
	rmSync(bin, { recursive: true, force: true });
	process.env = { ...savedEnv };
});

describe("isAndroidHost", () => {
	test("platform android, TERMUX_VERSION and a com.termux PREFIX all count", () => {
		expect(isAndroidHost("android", {})).toBe(true);
		expect(isAndroidHost("linux", { TERMUX_VERSION: "0.118" })).toBe(true);
		expect(isAndroidHost("linux", { PREFIX: "/data/data/com.termux/files/usr" })).toBe(true);
		expect(isAndroidHost("linux", {})).toBe(false);
		expect(isAndroidHost("darwin", {})).toBe(false);
	});
});

describe("recorder on Android", () => {
	test("missing termux-microphone-record names the exact install step", async () => {
		const rec = new MicRecorder({}, { android: true, env: fakePath("ffmpeg") });
		const errors: string[] = [];
		rec.on("error", ({ message }) => errors.push(message));
		await expect(rec.start()).rejects.toThrow("pkg install termux-api");
		expect(errors[0]).toBe(TERMUX_MIC_MISSING);
		expect(TERMUX_MIC_MISSING).toContain("Termux:API app from F-Droid");
	});

	test("missing ffmpeg names pkg install ffmpeg", async () => {
		const rec = new MicRecorder({}, { android: true, env: fakePath("termux-microphone-record") });
		rec.on("error", () => {});
		await expect(rec.start()).rejects.toThrow(TERMUX_FFMPEG_MISSING);
		expect(TERMUX_FFMPEG_MISSING).toContain("pkg install ffmpeg");
	});

	test("records with -f/-l, stops with -q, converts to the WAV path", async () => {
		const env = fakePath("termux-microphone-record", "ffmpeg");
		const calls: string[][] = [];
		const converted: string[][] = [];
		const rec = new MicRecorder(
			{ maxDurationSeconds: 12, outputPath: join(bin, "say.wav") },
			{
				android: true,
				env,
				finalizeMs: 0,
				run: async (cmd) => {
					calls.push(cmd);
					return 0;
				},
				convert: async (a, b) => {
					converted.push([a, b]);
				},
			},
		);
		const out = await rec.start();
		expect(out).toBe(join(bin, "say.wav"));
		expect(calls[0]?.[0]).toBe(join(bin, "termux-microphone-record"));
		expect(calls[0]).toContain("-f");
		expect(calls[0]?.[calls[0].indexOf("-l") + 1]).toBe("12");
		const result = await rec.stop();
		expect(calls[1]?.slice(1)).toEqual(["-q"]);
		expect(converted).toEqual([[join(bin, "say.m4a"), join(bin, "say.wav")]]);
		expect(result.path).toBe(join(bin, "say.wav"));
		expect(rec.getIsRecording()).toBe(false);
	});

	test("a non-zero exit from termux-microphone-record points at the microphone permission", async () => {
		const rec = new MicRecorder(
			{},
			{
				android: true,
				env: fakePath("termux-microphone-record", "ffmpeg"),
				run: async () => 1,
			},
		);
		rec.on("error", () => {});
		await expect(rec.start()).rejects.toThrow("allow the microphone");
	});

	test("the sox hint on android is the Termux step, not apt", async () => {
		process.env.TERMUX_VERSION = "0.118";
		const r = await checkSoxInstalled();
		if (!r.installed) expect(r.installHint).toContain("pkg install termux-api");
	});
});

describe("transcriber on Android", () => {
	test("finds whisper-cli on PATH, and null when absent (whisper-cpp is not a Termux package)", async () => {
		expect(await findWhisperBinary(fakePath("whisper-cli"), true)).toBe(join(bin, "whisper-cli"));
		rmSync(join(bin, "whisper-cli"));
		expect(await findWhisperBinary({ PATH: bin }, true)).toBeNull();
	});

	test("the no-transcriber error names both the local and the cloud piece", () => {
		const m = transcriberMissingMessage();
		expect(m).toContain("whisper-cli not found");
		expect(m).toContain("OPENAI_API_KEY not set");
	});
});

describe("tts on Android", () => {
	const spawned: string[][] = [];
	const spawnFn = (cmd: string[]) => {
		spawned.push(cmd);
		return { kill() {}, exited: Promise.resolve(0) } as never;
	};

	test("silent when voice output is off, even with termux-tts-speak present", async () => {
		spawned.length = 0;
		const env = fakePath("termux-tts-speak");
		const p = new TermuxTTSProvider(env, () => voiceOutputOn(env), spawnFn);
		expect(await (await p.speak("hello")).exited).toBe(0);
		expect(spawned).toEqual([]);
	});

	test("speaks with termux-tts-speak when EIGHT_VOICE=1", async () => {
		spawned.length = 0;
		const env = { ...fakePath("termux-tts-speak"), EIGHT_VOICE: "1" };
		const p = new TermuxTTSProvider(env, () => voiceOutputOn(env), spawnFn);
		await (await p.speak("hello")).exited;
		expect(spawned).toEqual([[join(bin, "termux-tts-speak"), "hello"]]);
		expect(await p.isAvailable()).toBe(true);
	});

	test("missing termux-tts-speak is unavailable and exits 127 without spawning", async () => {
		spawned.length = 0;
		const env = { ...fakePath(), EIGHT_VOICE: "1" };
		const p = new TermuxTTSProvider(env, () => true, spawnFn);
		expect(await p.isAvailable()).toBe(false);
		expect(await (await p.speak("hi")).exited).toBe(127);
		expect(spawned).toEqual([]);
	});

	test("the engine picks the termux provider on Android", async () => {
		process.env.TERMUX_VERSION = "0.118";
		process.env.PATH = bin;
		fakePath("termux-tts-speak");
		expect(await new TTSEngine().getProviderName()).toBe("termux");
	});

	test("voiceOutputOn reads only the raw settings file: literal true, or EIGHT_VOICE=1", () => {
		const read = (v: unknown) => () => JSON.stringify(v);
		expect(voiceOutputOn({}, read({ voice: { outputEnabled: true } }))).toBe(true);
		expect(voiceOutputOn({}, read({ voice: { outputEnabled: "true" } }))).toBe(false);
		expect(voiceOutputOn({}, read({}))).toBe(false);
		expect(voiceOutputOn({}, () => "not json")).toBe(false);
		expect(
			voiceOutputOn({}, () => {
				throw new Error("no file");
			}),
		).toBe(false);
		expect(voiceOutputOn({ EIGHT_VOICE: "1" }, read({}))).toBe(true);
		expect(voiceOutputOn({ EIGHT_VOICE: "0" }, read({}))).toBe(false);
	});
});

describe("/voice status line on Android", () => {
	test("everything missing: per-dependency state with the exact install line", () => {
		const line = describeTermuxVoice(fakePath());
		expect(line).toContain(
			"voice: input=missing (termux-microphone-record: install the Termux:API app from F-Droid, then run: pkg install termux-api",
		);
		expect(line).toContain("ffmpeg: pkg install ffmpeg");
		expect(line).toContain("transcribe=missing (whisper-cli:");
		expect(line).toContain("cloud key: export OPENAI_API_KEY");
		expect(line).toContain("output=missing (termux-tts-speak:");
	});

	test("all present: ok, local whisper preferred over the cloud key", () => {
		const env = {
			...fakePath("termux-microphone-record", "ffmpeg", "termux-tts-speak", "whisper-cli"),
			OPENAI_API_KEY: "x",
		};
		expect(describeTermuxVoice(env)).toBe(
			"voice: input=ok transcribe=ok (whisper-cli local) output=ok",
		);
	});

	test("cloud key alone satisfies transcribe", () => {
		const env = { ...fakePath("termux-microphone-record", "ffmpeg"), OPENAI_API_KEY: "x" };
		expect(describeTermuxVoice(env)).toContain("transcribe=ok (OpenAI cloud)");
	});

	test("describeMissingVoiceSetup gives the Termux line, never brew or apt", () => {
		process.env.TERMUX_VERSION = "0.118";
		process.env.PATH = bin;
		const lines = describeMissingVoiceSetup({
			soxPath: null,
			whisperBinaryPath: null,
			downloadedModels: [],
			modelsDir: "/m",
			platform: "android",
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("pkg install termux-api");
		expect(lines[0]).not.toMatch(/brew|apt/);
	});
});

describe("dj install hint", () => {
	test("android gets the pkg line (yt-dlp ships as python-yt-dlp in Termux)", () => {
		expect(installHint("android")).toBe("pkg install mpv python-yt-dlp ffmpeg");
		expect(installHint("darwin")).toContain("brew install");
	});
});

test("findOnPath ignores non-executable files", () => {
	writeFileSync(join(bin, "plain"), "x");
	expect(findOnPath("plain", { PATH: bin })).toBeNull();
});
