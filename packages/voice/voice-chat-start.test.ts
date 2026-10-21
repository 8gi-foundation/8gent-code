/**
 * /voice chat start path and the shared whisper model resolution.
 *
 * sox `rec` and `whisper-cli` are replaced by small shell scripts on PATH, so
 * the loop's real spawn, silence-stop handling, model lookup and error
 * reporting run with no microphone and no model download.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceEngine } from "./index";
import { missingWhisperModelMessage, resolveWhisperModel } from "./model-manager";
import { TTSEngine, type TTSProcess, setTTSEngine } from "./tts-engine";
import { VoiceChatLoop, describeRecFailure } from "./voice-chat";

describe("resolveWhisperModel", () => {
	const only =
		(...paths: string[]) =>
		(p: string) =>
			paths.includes(p);

	test("prefers the largest installed model", () => {
		const m = resolveWhisperModel({
			modelsDir: "/m",
			exists: only("/m/ggml-tiny.bin", "/m/ggml-base.bin", "/m/ggml-small.bin"),
		});
		expect(m?.path).toBe("/m/ggml-small.bin");
		expect(m?.name).toBe("small");
	});

	test("works with only tiny, the file Ctrl+R downloads", () => {
		const m = resolveWhisperModel({ modelsDir: "/m", exists: only("/m/ggml-tiny.bin") });
		expect(m?.path).toBe("/m/ggml-tiny.bin");
	});

	test("never requires one hardcoded file name", () => {
		expect(
			resolveWhisperModel({ modelsDir: "/m", exists: only("/m/ggml-base.en.bin") })?.name,
		).toBe("base");
		expect(resolveWhisperModel({ modelsDir: "/m", exists: () => false })).toBeNull();
	});

	test("skips English-only models for other languages", () => {
		const m = resolveWhisperModel({
			modelsDir: "/m",
			language: "fr",
			exists: only("/m/ggml-base.en.bin", "/m/ggml-tiny.bin"),
		});
		expect(m?.path).toBe("/m/ggml-tiny.bin");
	});

	test("searches extra directories after the primary one", () => {
		const m = resolveWhisperModel({
			modelsDir: "/m",
			extraDirs: ["/home/models"],
			exists: only("/home/models/ggml-base.en.bin"),
		});
		expect(m?.path).toBe("/home/models/ggml-base.en.bin");
	});

	test("the missing-model message names the one command that fixes it", () => {
		const msg = missingWhisperModelMessage("/m");
		expect(msg).toContain("curl -L -o /m/ggml-tiny.bin");
		expect(msg).toContain("mkdir -p /m");
	});
});

describe("VoiceChatLoop start path (sox and whisper faked)", () => {
	let dir: string;
	let oldPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "vc-start-"));
		mkdirSync(join(dir, "bin"));
		mkdirSync(join(dir, "models"));
		oldPath = process.env.PATH;
		process.env.PATH = `${join(dir, "bin")}:${oldPath}`;
	});
	afterEach(() => {
		process.env.PATH = oldPath;
		rmSync(dir, { recursive: true, force: true });
	});

	const script = (name: string, body: string) => {
		const p = join(dir, "bin", name);
		writeFileSync(p, `#!/bin/sh\n${body}\n`);
		chmodSync(p, 0o755);
	};

	class QuietTTS extends TTSEngine {
		spoken: string[] = [];
		async speak(text: string): Promise<TTSProcess> {
			this.spoken.push(text);
			return { kill: () => {}, exited: Promise.resolve(0) };
		}
		async interrupt() {}
	}

	const waitFor = async (cond: () => boolean, ms = 8000) => {
		const t0 = Date.now();
		while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
		return cond();
	};

	test("a failing mic is reported in plain words and ends the loop", async () => {
		script("rec", 'echo "rec FAIL coreaudio: no input device" >&2; exit 2');
		const errors: string[] = [];
		let stopped = false;
		const loop = new VoiceChatLoop({
			engine: new VoiceEngine({ modelsPath: join(dir, "models") }),
			onMessage: async () => "never",
			onError: (m) => errors.push(m),
		});
		loop.on("stopped", () => {
			stopped = true;
		});
		await loop.start();
		expect(await waitFor(() => stopped)).toBe(true);
		expect(errors[0]).toContain("Could not record from the microphone");
		expect(errors[0]).toContain("no input device");
		expect(errors[0]).toContain("Privacy & Security > Microphone");
		expect(loop.isRunning()).toBe(false);
	});

	test("listen, transcribe with the installed model, think, speak", async () => {
		// Only a base.en model is installed: the loop must use it, not demand tiny.
		writeFileSync(join(dir, "models", "ggml-base.en.bin"), "x");
		// fake rec: write a WAV-sized file to the output path (the arg after "wav")
		script(
			"rec",
			'while [ $# -gt 0 ]; do if [ "$1" = wav ]; then out="$2"; fi; shift; done; head -c 64000 /dev/zero > "$out"',
		);
		// fake whisper-cli: prints the model it was given, proving which one was chosen
		script(
			"whisper-cli",
			'while [ $# -gt 0 ]; do if [ "$1" = -m ]; then m="$2"; fi; shift; done; echo "heard via $(basename "$m")"',
		);
		const tts = new QuietTTS();
		setTTSEngine(tts);
		const said: string[] = [];
		const heard: string[] = [];
		const loop = new VoiceChatLoop({
			engine: new VoiceEngine({ modelsPath: join(dir, "models") }),
			onMessage: async (t) => {
				heard.push(t);
				return "Hello back.";
			},
			onError: (m) => said.push(`ERR ${m}`),
		});
		await loop.start();
		expect(await waitFor(() => tts.spoken.length > 0)).toBe(true);
		await loop.stop();
		expect(said).toEqual([]);
		expect(heard[0]).toContain("heard via ggml-base.en.bin");
		expect(tts.spoken[0]).toBe("Hello back.");
	});

	test("describeRecFailure keeps the exit code and the first stderr line", () => {
		expect(describeRecFailure(3, "boom")).toContain("code 3 (boom)");
		expect(describeRecFailure(3, "")).not.toContain("()");
	});
});
