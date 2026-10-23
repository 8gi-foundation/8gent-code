import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHint } from "../music/dj.js";
import { checkSoxInstalled } from "./recorder.js";
import {
	ANDROID_DICTATION_LINE,
	ANDROID_VOICE_LINE_SUBS,
	ANDROID_VOICE_LISTEN_SUBS,
	TERMUX_TTS_HINT,
	ctrlRAction,
	findOnPath,
	isAndroidHost,
	voiceOutputOn,
} from "./termux.js";
import {
	TTSEngine,
	TermuxTTSProvider,
	getTTSEngine,
	installTermuxTTSEngine,
} from "./tts-engine.js";

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
		const p = new TermuxTTSProvider(
			env,
			() => true,
			spawnFn,
			() => {},
		);
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

describe("android dictation line", () => {
	test("is the one line, with no sox or whisper mention", () => {
		expect(ANDROID_DICTATION_LINE).toBe(
			"On Android, press Ctrl+R (or /voice record) to speak; the text lands in the prompt. Spoken replies: /voice on (needs termux-tts-speak: pkg install termux-api plus the Termux:API app).",
		);
		expect(ANDROID_DICTATION_LINE).not.toMatch(/sox|whisper/i);
	});

	test("recorder install hint on android is that line; desktop keeps sox hints", async () => {
		process.env.TERMUX_VERSION = "0.118";
		process.env.PATH = bin;
		const r = await checkSoxInstalled();
		expect(r.installHint).toBe(
			process.platform === "darwin" ? "Install with: brew install sox" : ANDROID_DICTATION_LINE,
		);
		delete process.env.TERMUX_VERSION;
		delete process.env.PREFIX;
		if (process.platform === "darwin")
			expect((await checkSoxInstalled()).installHint).toContain("brew install sox");
	});
});

describe("review fixes (#4726)", () => {
	test("Ctrl+R on Android listens through Termux:API and never toggles recording; desktop toggles", () => {
		expect(ctrlRAction({ ctrl: true }, "r", true)).toBe("android-listen");
		expect(ctrlRAction({ ctrl: true }, "r", false)).toBe("toggle");
		expect(ctrlRAction({ ctrl: false }, "r", true)).toBe("ignore");
		expect(ctrlRAction({ ctrl: true }, "x", true)).toBe("ignore");
	});

	test("the Android /voice intercept covers bare, chat, record, status and stop but not on/off", () => {
		for (const sub of ["", "chat", "conversation", "talk", "status", "stop"]) {
			expect(ANDROID_VOICE_LINE_SUBS).toContain(sub);
		}
		for (const sub of ["record", "listen", "stt"]) {
			expect(ANDROID_VOICE_LINE_SUBS).not.toContain(sub);
			expect(ANDROID_VOICE_LISTEN_SUBS).toContain(sub);
		}
		expect(ANDROID_VOICE_LINE_SUBS).not.toContain("on");
		expect(ANDROID_VOICE_LINE_SUBS).not.toContain("off");
	});

	test("output on but termux-tts-speak missing: one hint, exit 127, no spawn", async () => {
		const hints: string[] = [];
		const spawned: string[][] = [];
		const env = { ...fakePath(), EIGHT_VOICE: "1" };
		const p = new TermuxTTSProvider(
			env,
			() => true,
			((c: string[]) => {
				spawned.push(c);
				return {} as never;
			}) as never,
			(m) => hints.push(m),
		);
		expect(await (await p.speak("a")).exited).toBe(127);
		expect(await (await p.speak("b")).exited).toBe(127);
		expect(hints).toEqual([TERMUX_TTS_HINT]);
		expect(TERMUX_TTS_HINT).toContain("pkg install termux-api");
		expect(TERMUX_TTS_HINT).toContain("Termux:API app");
		expect(spawned).toEqual([]);
	});

	test("a spawn that throws is caught and turns into the hint", async () => {
		const hints: string[] = [];
		const env = fakePath("termux-tts-speak");
		const p = new TermuxTTSProvider(
			env,
			() => true,
			() => {
				throw new Error("ENOENT");
			},
			(m) => hints.push(m),
		);
		expect(await (await p.speak("a")).exited).toBe(127);
		expect(hints).toEqual([TERMUX_TTS_HINT]);
	});

	test("output off stays silent with no hint even when the tool is missing", async () => {
		const hints: string[] = [];
		const p = new TermuxTTSProvider(
			fakePath(),
			() => false,
			(() => ({})) as never,
			(m) => hints.push(m),
		);
		expect(await (await p.speak("a")).exited).toBe(0);
		expect(hints).toEqual([]);
	});
});

describe("hint routing (#4726)", () => {
	test("the default provider writes nothing to stderr or stdout", async () => {
		const out: string[] = [];
		const origErr = console.error;
		const origLog = console.log;
		const origW = process.stderr.write;
		console.error = (...a) => void out.push(a.join(" "));
		console.log = (...a) => void out.push(a.join(" "));
		process.stderr.write = ((c: string) => {
			out.push(String(c));
			return true;
		}) as never;
		try {
			const p = new TermuxTTSProvider({ ...fakePath(), EIGHT_VOICE: "1" }, () => true);
			expect(await (await p.speak("a")).exited).toBe(127);
		} finally {
			console.error = origErr;
			console.log = origLog;
			process.stderr.write = origW;
		}
		expect(out).toEqual([]);
	});

	test("installTermuxTTSEngine routes the hint to the supplied sink, once", async () => {
		const hints: string[] = [];
		process.env.PATH = bin;
		process.env.EIGHT_VOICE = "1";
		const engine = installTermuxTTSEngine((m) => hints.push(m));
		expect(getTTSEngine()).toBe(engine);
		await (await engine.speak("a")).exited;
		await (await engine.speak("b")).exited;
		expect(hints).toEqual([TERMUX_TTS_HINT]);
	});
});
