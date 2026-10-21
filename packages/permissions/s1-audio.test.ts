import { describe, expect, test } from "bun:test";
import { AUDIO_REFUSAL, audioRefusal, isAudioCommand } from "./s1-audio";
import { systemOneGate } from "./system-one-gate";

describe("System One audio lane (#4713)", () => {
	test("names the audio commands", () => {
		for (const c of [
			'say "hi"',
			"afplay /tmp/a.wav",
			"/usr/bin/say hello",
			"echo done && say finished",
			"osascript -e 'display notification \"x\"'",
			"termux-tts-speak hi",
			"espeak hi",
			"paplay a.wav",
		]) {
			expect(isAudioCommand(c)).toBe(true);
		}
		for (const c of ["ls", "echo say hi", "osascript -e 'tell app \"Finder\" to activate'"]) {
			expect(isAudioCommand(c)).toBe(false);
		}
	});

	test("headless refuses with the fixed text, even with voice on", () => {
		expect(audioRefusal('say "hi"', { tui: false, voiceOn: false })).toBe(AUDIO_REFUSAL);
		expect(audioRefusal('say "hi"', { tui: false, voiceOn: true })).toBe(AUDIO_REFUSAL);
	});

	test("TUI passes the lane only when voice is on", () => {
		expect(audioRefusal('say "hi"', { tui: true, voiceOn: false })).toBe(AUDIO_REFUSAL);
		expect(audioRefusal('say "hi"', { tui: true, voiceOn: true })).toBeUndefined();
	});

	test("the gate denies say headless", async () => {
		const r = await systemOneGate('say "hi"', { EIGHT_SYSTEM_ONE: "1", EIGHT_VOICE: "1" });
		expect(r.run).toBe(false);
		expect(r.message).toContain(AUDIO_REFUSAL);
	});
});
