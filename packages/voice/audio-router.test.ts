/**
 * VoiceEngine audio router (issue #3688): a recorded clip can be handled
 * before transcription. Offline: the mic recorder and Whisper are faked.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceEngine } from "./index";

// biome-ignore lint/suspicious/noExplicitAny: test reaches private engine fields to fake the mic.
type Internals = any;

function engineWithClip(durationMs = 1000): {
	engine: VoiceEngine;
	wavPath: string;
	transcribed: () => boolean;
} {
	const engine = new VoiceEngine();
	const wavPath = join(tmpdir(), `8gent-router-test-${Date.now()}-${Math.random()}.wav`);
	writeFileSync(wavPath, "RIFF");
	let didTranscribe = false;
	const e = engine as Internals;
	e.state = "recording";
	e.recorder = { stop: async () => ({ path: wavPath, durationMs }) };
	e.transcribe = async () => {
		didTranscribe = true;
		return { text: "hello", isFinal: true };
	};
	return { engine, wavPath, transcribed: () => didTranscribe };
}

describe("VoiceEngine audio router", () => {
	it("skips transcription when the router handles the clip", async () => {
		const { engine, wavPath, transcribed } = engineWithClip();
		let seen = "";
		engine.setAudioRouter(async (p) => {
			seen = p;
			return true;
		});
		const out = await engine.stopRecording();
		expect(seen).toBe(wavPath);
		expect(transcribed()).toBe(false);
		expect(out).toBeNull();
		expect(engine.getState()).toBe("idle");
		expect(existsSync(wavPath)).toBe(false);
	});

	it("falls back to transcription when the router declines", async () => {
		const { engine, transcribed } = engineWithClip();
		engine.setAudioRouter(async () => false);
		const out = await engine.stopRecording();
		expect(transcribed()).toBe(true);
		expect(out?.text).toBe("hello");
	});

	it("falls back to transcription when the router throws", async () => {
		const { engine, transcribed } = engineWithClip();
		engine.setAudioRouter(async () => {
			throw new Error("boom");
		});
		await engine.stopRecording();
		expect(transcribed()).toBe(true);
	});

	it("transcribes as before with no router set", async () => {
		const { engine, transcribed } = engineWithClip();
		await engine.stopRecording();
		expect(transcribed()).toBe(true);
	});
});
