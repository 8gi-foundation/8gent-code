import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BUILD_PKGS,
	PHONE_MODELS,
	RECORD_LIMIT_S,
	type RecordDeps,
	WHISPER_SOURCE,
	buildWhisper,
	cleanWhisperText,
	convertFailedLine,
	ffmpegArgs,
	findPhoneModel,
	findWhisperBin,
	heardNothingLine,
	installPhoneModel,
	localVoiceNeeds,
	localVoiceReady,
	managedWhisperBin,
	noAudioLine,
	phoneModelsDir,
	recordFailedLine,
	sha256File,
	startRecording,
	whisperArgs,
} from "./termux-local-stt.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "termux-local-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A directory holding fake executables with these names. */
function binDir(...names: string[]): string {
	const d = join(root, "bin");
	mkdirSync(d, { recursive: true });
	for (const n of names) {
		writeFileSync(join(d, n), "#!/bin/sh\n");
		chmodSync(join(d, n), 0o755);
	}
	return d;
}

describe("whisper.cpp detection", () => {
	test("finds whisper-cli on PATH first, then whisper-cpp, then the one built under ~/.8gent/bin", () => {
		const env = { HOME: root, EIGHT_HOME: root, PATH: binDir("whisper-cli", "whisper-cpp") };
		expect(findWhisperBin(env)).toBe(join(root, "bin", "whisper-cli"));
		rmSync(join(root, "bin", "whisper-cli"));
		expect(findWhisperBin(env)).toBe(join(root, "bin", "whisper-cpp"));
		rmSync(join(root, "bin", "whisper-cpp"));
		expect(findWhisperBin(env)).toBeNull();
		const managed = managedWhisperBin(env);
		expect(managed).toBe(join(root, ".8gent", "bin", "whisper-cli"));
		expect(findWhisperBin(env, (p) => p === managed)).toBe(managed);
	});
});

describe("model detection", () => {
	test("looks in ~/.8gent/models/whisper and prefers base.en over tiny.en", () => {
		const env = { HOME: root, EIGHT_HOME: root };
		const dir = phoneModelsDir(env);
		expect(dir).toBe(join(root, ".8gent", "models", "whisper"));
		expect(findPhoneModel(env)).toBeNull();
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, PHONE_MODELS.tiny.filename), "x");
		expect(findPhoneModel(env)).toBe(join(dir, "ggml-tiny.en.bin"));
		writeFileSync(join(dir, PHONE_MODELS.base.filename), "x");
		expect(findPhoneModel(env)).toBe(join(dir, "ggml-base.en.bin"));
	});

	test("a partial download is not a model", () => {
		const env = { HOME: root, EIGHT_HOME: root };
		mkdirSync(phoneModelsDir(env), { recursive: true });
		writeFileSync(join(phoneModelsDir(env), "ggml-tiny.en.bin.part"), "x");
		expect(findPhoneModel(env)).toBeNull();
	});
});

describe("what is missing", () => {
	test("a missing whisper-cli is downloaded, never built: no build tool is ever a need", () => {
		const none = () => false;
		expect(localVoiceNeeds(none, null, null)).toEqual({
			pkgs: ["termux-api", "ffmpeg"],
			whisper: true,
			model: true,
		});
		for (const p of BUILD_PKGS) expect(localVoiceNeeds(none, null, null).pkgs).not.toContain(p);
		expect(localVoiceNeeds(none, "/x/whisper-cli", null).pkgs).toEqual(["termux-api", "ffmpeg"]);
		const all = localVoiceNeeds(() => true, "/x/whisper-cli", "/x/m.bin");
		expect(all).toEqual({ pkgs: [], whisper: false, model: false });
		expect(localVoiceReady(all)).toBe(true);
		expect(localVoiceReady(localVoiceNeeds(() => true, "/x/w", null))).toBe(false);
	});
});

describe("official sources", () => {
	test("models come from the whisper.cpp Hugging Face repo, English-only, with sha256 and sizes", () => {
		for (const m of Object.values(PHONE_MODELS)) {
			expect(m.url).toBe(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${m.filename}`);
			expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(m.filename).toEndWith(".en.bin");
		}
		expect(PHONE_MODELS.tiny.bytes).toBeLessThan(PHONE_MODELS.base.bytes);
	});

	test("whisper.cpp source is a pinned release tag from ggml-org with a sha256", () => {
		expect(WHISPER_SOURCE.url).toBe(
			`https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${WHISPER_SOURCE.version}.tar.gz`,
		);
		expect(WHISPER_SOURCE.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	test("sha256File hashes the bytes on disk", async () => {
		const p = join(root, "f");
		writeFileSync(p, "abc");
		expect(await sha256File(p)).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});

describe("model install", () => {
	const env = () => ({ HOME: root, EIGHT_HOME: root });
	const run = async () => 0;

	test("a matching checksum keeps the model under its real name", async () => {
		const urls: string[] = [];
		const r = await installPhoneModel("tiny", run, env(), {
			download: async (url, path) => {
				urls.push(url);
				writeFileSync(path, "model");
				return true;
			},
			hash: async () => PHONE_MODELS.tiny.sha256,
		});
		expect(r).toEqual({ path: join(phoneModelsDir(env()), "ggml-tiny.en.bin") });
		expect(urls).toEqual([PHONE_MODELS.tiny.url]);
		expect(readdirSync(phoneModelsDir(env()))).toEqual(["ggml-tiny.en.bin"]);
	});

	test("a wrong checksum deletes the download and leaves no model", async () => {
		const r = await installPhoneModel("base", run, env(), {
			download: async (_u, path) => {
				writeFileSync(path, "tampered");
				return true;
			},
		});
		expect(r).toEqual({
			error: "ggml-base.en.bin failed its checksum, so it was deleted. Try again.",
		});
		expect(readdirSync(phoneModelsDir(env()))).toEqual([]);
		expect(findPhoneModel(env())).toBeNull();
	});

	test("a failed download leaves nothing behind", async () => {
		const r = await installPhoneModel("tiny", run, env(), {
			download: async (_u, path) => {
				writeFileSync(path, "half");
				return false;
			},
		});
		expect("error" in r).toBe(true);
		expect(readdirSync(phoneModelsDir(env()))).toEqual([]);
	});

	test("the default download is curl -f to a .part file", async () => {
		const calls: string[][] = [];
		await installPhoneModel(
			"tiny",
			async (cmd, args) => {
				calls.push([cmd, ...args]);
				return 22;
			},
			env(),
		);
		const part = join(phoneModelsDir(env()), "ggml-tiny.en.bin.part");
		expect(calls).toEqual([["curl", "-fsSL", "--retry", "2", "-o", part, PHONE_MODELS.tiny.url]]);
	});
});

describe("whisper.cpp build", () => {
	function buildRig(o: { hash?: string; buildCode?: number; produced?: boolean } = {}) {
		const work = join(root, "work");
		mkdirSync(work);
		const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
		const copies: [string, string][] = [];
		const run = async (cmd: string, args: string[], _l: unknown, opts?: { cwd?: string }) => {
			calls.push({ cmd, args, cwd: opts?.cwd });
			if (cmd === "cmake" && args[0] === "--build") return o.buildCode ?? 0;
			return 0;
		};
		const env = { HOME: root, EIGHT_HOME: root };
		const go = () =>
			buildWhisper(run, () => {}, env, {
				workDir: work,
				jobs: 2,
				download: async () => true,
				hash: async () => o.hash ?? WHISPER_SOURCE.sha256,
				exists: () => o.produced ?? true,
				copy: (from, to) => copies.push([from, to]),
			});
		return { go, calls, copies, work, env };
	}

	test("unpacks the pinned tarball, builds a static whisper-cli, copies it to ~/.8gent/bin, removes the source", async () => {
		const r = buildRig();
		const out = await r.go();
		const src = join(r.work, "src");
		expect(out).toEqual({ path: managedWhisperBin(r.env) });
		expect(r.calls).toEqual([
			{
				cmd: "tar",
				args: ["-xzf", join(r.work, "whisper.tar.gz"), "-C", src, "--strip-components=1"],
				cwd: undefined,
			},
			{
				cmd: "cmake",
				args: [
					"-B",
					"build",
					"-DCMAKE_BUILD_TYPE=Release",
					"-DBUILD_SHARED_LIBS=OFF",
					"-DWHISPER_BUILD_TESTS=OFF",
					"-DWHISPER_BUILD_SERVER=OFF",
				],
				cwd: src,
			},
			{
				cmd: "cmake",
				args: ["--build", "build", "-j", "2", "--config", "Release", "--target", "whisper-cli"],
				cwd: src,
			},
		]);
		expect(r.copies).toEqual([
			[join(src, "build", "bin", "whisper-cli"), managedWhisperBin(r.env)],
		]);
		expect(existsSync(r.work)).toBe(false);
	});

	test("a tarball that fails its checksum is never unpacked or compiled", async () => {
		const r = buildRig({ hash: "0".repeat(64) });
		expect(await r.go()).toEqual({
			error: `Building whisper.cpp ${WHISPER_SOURCE.version} did not finish (checksum did not match).`,
		});
		expect(r.calls).toEqual([]);
		expect(existsSync(r.work)).toBe(false);
	});

	test("a failed compile says so and copies nothing", async () => {
		const r = buildRig({ buildCode: 2 });
		expect(await r.go()).toEqual({
			error: `Building whisper.cpp ${WHISPER_SOURCE.version} did not finish (build exit 2).`,
		});
		expect(r.copies).toEqual([]);
		expect(existsSync(r.work)).toBe(false);
	});
});

describe("transcript text", () => {
	test("blank-audio markers and control characters are removed", () => {
		expect(cleanWhisperText(" [BLANK_AUDIO]\n")).toBe("");
		expect(cleanWhisperText("\n hello\u001b[31m world \n")).toBe("hello [31m world");
		expect(cleanWhisperText("a‮b")).toBe("ab");
	});

	test("call shapes: ffmpeg to 16 kHz mono 16-bit WAV, whisper-cli English with no timestamps", () => {
		expect(ffmpegArgs("in.m4a", "out.wav")).toEqual([
			"-nostdin",
			"-y",
			"-loglevel",
			"error",
			"-i",
			"in.m4a",
			"-ar",
			"16000",
			"-ac",
			"1",
			"-c:a",
			"pcm_s16le",
			"out.wav",
		]);
		expect(whisperArgs("m.bin", "a.wav", 4)).toEqual([
			"-m",
			"m.bin",
			"-f",
			"a.wav",
			"-l",
			"en",
			"-nt",
			"-np",
			"-ng",
			"-t",
			"4",
		]);
	});
});

describe("record, transcribe, delete", () => {
	/**
	 * A fake phone. The recorder writes the file when started; ffmpeg writes the WAV;
	 * whisper prints `text`. Every command is logged. The audio directory is real, so
	 * the test can check it is gone afterwards.
	 */
	function phone(
		o: {
			startCode?: number;
			recordBytes?: string;
			ffmpegCode?: number;
			whisperCode?: number | null;
			text?: string;
		} = {},
	) {
		const runs: string[][] = [];
		const captures: string[][] = [];
		let dir = "";
		const deps: RecordDeps = {
			whisperBin: "/fake/whisper-cli",
			modelPath: "/fake/ggml-tiny.en.bin",
			threads: 2,
			makeDir: () => {
				dir = mkdtempSync(join(root, "voice-"));
				return dir;
			},
			sleep: async () => {},
			sweep: () => {},
			quitSync: () => {},
			run: async (cmd, args) => {
				runs.push([cmd, ...args]);
				if (args[0] === "-f" && (o.startCode ?? 0) === 0)
					writeFileSync(args[1], o.recordBytes ?? "aac-bytes");
				return args[0] === "-f" ? (o.startCode ?? 0) : 0;
			},
			capture: async (cmd, args) => {
				captures.push([cmd, ...args]);
				if (cmd === "ffmpeg") {
					if ((o.ffmpegCode ?? 0) === 0) writeFileSync(args.at(-1) as string, "wav");
					return { code: o.ffmpegCode ?? 0, out: "" };
				}
				return {
					code: o.whisperCode === undefined ? 0 : o.whisperCode,
					out: o.text ?? " hello world\n",
				};
			},
		};
		return { deps, runs, captures, dir: () => dir };
	}

	test("records 16 kHz mono with a limit, stops on request, transcribes, then deletes both audio files", async () => {
		const p = phone();
		const rec = await startRecording(p.deps);
		if ("error" in rec) throw new Error(rec.error);
		const audioDir = p.dir();
		expect(p.runs[0]).toEqual([
			"termux-microphone-record",
			"-f",
			join(audioDir, "voice.m4a"),
			"-l",
			String(RECORD_LIMIT_S),
			"-e",
			"aac",
			"-r",
			"16000",
			"-c",
			"1",
		]);
		rec.stop();
		rec.stop();
		expect(await rec.done).toEqual({ text: "hello world" });
		expect(p.runs[1]).toEqual(["termux-microphone-record", "-q"]);
		expect(p.runs).toHaveLength(2);
		expect(p.captures.map((c) => c[0])).toEqual(["ffmpeg", "/fake/whisper-cli"]);
		expect(p.captures[1]).toEqual([
			"/fake/whisper-cli",
			...whisperArgs("/fake/ggml-tiny.en.bin", join(audioDir, "voice.wav"), 2),
		]);
		expect(existsSync(audioDir)).toBe(false);
	});

	test("never calls the cloud recogniser", async () => {
		const p = phone();
		const rec = await startRecording(p.deps);
		if ("error" in rec) throw new Error(rec.error);
		rec.stop();
		await rec.done;
		const all = [...p.runs, ...p.captures].flat().join(" ");
		expect(all).not.toContain("termux-speech-to-text");
	});

	test("stops by itself at the limit and still deletes the audio", async () => {
		const p = phone();
		const rec = await startRecording({ ...p.deps, limitS: 0.01 });
		if ("error" in rec) throw new Error(rec.error);
		expect(await rec.done).toEqual({ text: "hello world" });
		expect(existsSync(p.dir())).toBe(false);
	});

	test("audio is deleted when ffmpeg fails", async () => {
		const p = phone({ ffmpegCode: 1 });
		const rec = await startRecording(p.deps);
		if ("error" in rec) throw new Error(rec.error);
		rec.stop();
		expect(await rec.done).toEqual({ error: convertFailedLine });
		expect(existsSync(p.dir())).toBe(false);
	});

	test("audio is deleted when whisper fails or times out", async () => {
		for (const code of [3, null]) {
			const p = phone({ whisperCode: code });
			const rec = await startRecording(p.deps);
			if ("error" in rec) throw new Error(rec.error);
			rec.stop();
			const r = await rec.done;
			expect("error" in r).toBe(true);
			expect(existsSync(p.dir())).toBe(false);
		}
	});

	test("audio is deleted when nothing was heard", async () => {
		const p = phone({ text: "[BLANK_AUDIO]\n" });
		const rec = await startRecording(p.deps);
		if ("error" in rec) throw new Error(rec.error);
		rec.stop();
		expect(await rec.done).toEqual({ error: heardNothingLine });
		expect(existsSync(p.dir())).toBe(false);
	});

	test("an empty recording is reported, not transcribed, and its directory removed", async () => {
		const p = phone({ recordBytes: "" });
		const rec = await startRecording(p.deps);
		if ("error" in rec) throw new Error(rec.error);
		rec.stop();
		expect(await rec.done).toEqual({ error: noAudioLine });
		expect(p.captures).toEqual([]);
		expect(existsSync(p.dir())).toBe(false);
	});

	test("a recorder that will not start returns one line and leaves no directory", async () => {
		const p = phone({ startCode: 1 });
		expect(await startRecording(p.deps)).toEqual({ error: recordFailedLine });
		expect(existsSync(p.dir())).toBe(false);
	});
});

/**
 * End to end with the real tools: the recorder is faked by copying a phone-format
 * fixture (AAC, 16 kHz mono, as termux-microphone-record writes it), then the real
 * ffmpeg and the real whisper-cli run with the exact arguments the phone uses.
 *
 * Skipped unless WHISPER_E2E_MODEL points at ggml-tiny.en.bin and whisper-cli and
 * ffmpeg are on PATH. CI does not set it: the model is 78 MB and whisper.cpp would
 * have to be built on the runner, which the heavy-workflow budget does not allow.
 */
const e2eModel = process.env.WHISPER_E2E_MODEL ?? "";
const e2eBin = findWhisperBin(process.env);
const e2eReady =
	e2eModel !== "" && existsSync(e2eModel) && e2eBin !== null && Bun.which("ffmpeg") !== null;

describe.skipIf(!e2eReady)("end to end with whisper.cpp and the tiny.en model", () => {
	test("transcribes the fixture and deletes the audio", async () => {
		const fixture = join(import.meta.dir, "fixtures", "jfk-phone.m4a");
		let dir = "";
		const rec = await startRecording({
			whisperBin: e2eBin as string,
			modelPath: e2eModel,
			makeDir: () => {
				dir = mkdtempSync(join(root, "voice-"));
				return dir;
			},
			run: async (_cmd, args) => {
				if (args[0] === "-f") copyFileSync(fixture, args[1]);
				return 0;
			},
		});
		if ("error" in rec) throw new Error(rec.error);
		rec.stop();
		const r = await rec.done;
		expect("text" in r).toBe(true);
		const text = "text" in r ? r.text.toLowerCase() : "";
		expect(text).toContain("ask not what your country can do for you");
		expect(existsSync(dir)).toBe(false);
	}, 60_000);
});
