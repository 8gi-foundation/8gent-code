import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIO_REFUSAL, audioRefusal, isAudioCommand, voiceIsOn } from "./s1-audio";
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
		for (const c of ["ls", "git status"]) {
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

	test("wrapped audio commands are caught", () => {
		const wrapped = [
			'sh -c "say hi"',
			"bash -c 'say hi'",
			'zsh -c "say hi"',
			'bash -lc "say hi"',
			"env say hi",
			"env FOO=1 say hi",
			"/usr/bin/env say hi",
			"nohup say hi &",
			"command say hi",
			"time say hi",
			"sudo say hi",
			"sudo -u root say hi",
			"exec say hi",
			"echo hi | xargs say",
			"busybox say hi",
			"echo $(say hi)",
			"echo `say hi`",
			"(say hi)",
			'sh -c "ls; say hi"',
		];
		for (const c of wrapped) expect([c, isAudioCommand(c)]).toEqual([c, true]);
	});

	test("obfuscated and indirect audio commands are caught", () => {
		const cases = [
			"SAY=say; $SAY hi",
			"say$IFS'hi'",
			"sa''y hi",
			"\\say hi",
			"if true; then say hi; fi",
			"for f in *.aiff; do afplay $f; done",
			"{ say hi; }",
			"eval 'say hi'",
			"find . -exec say hi \\;",
			"find . -execdir afplay {} \\;",
			"sh <<< 'say hi'",
			"su -c 'say hi'",
			"ssh host say hi",
			"arch say hi",
			"caffeinate say hi",
			"! say hi",
			"while true; do say hi; done",
			"rg --pre say x .",
			"rg --pre=afplay x .",
			"grep --pre=say x .",
		];
		for (const c of cases) expect([c, isAudioCommand(c)]).toEqual([c, true]);
	});

	test("ordinary commands with pipes and anchors pass", () => {
		for (const c of [
			'grep -n "smoke\\|test" package.json',
			"sed -i '' 's|^X=a$|X=b|' f",
			"osascript -e 'tell application \"Finder\" to get name of startup disk'",
			"open notes.pdf",
		]) {
			expect([c, isAudioCommand(c)]).toEqual([c, false]);
		}
	});

	test("more players, loud osascript, open on audio, shell pipes and bell are refused", () => {
		for (const c of [
			"spd-say hi",
			"aplay a.wav",
			"ffplay a.mp3",
			"mpg123 a.mp3",
			"pw-play a.wav",
			"notify-send hi",
			"terminal-notifier -message hi",
			"osascript -e 'beep'",
			"osascript x.scpt",
			"osascript -l JavaScript -e 'app.displayNotification(\"x\")'",
			"open a.aiff",
			"open song.MP3",
			"echo say hi | sh",
			"tput bel",
		]) {
			expect([c, isAudioCommand(c)]).toEqual([c, true]);
		}
	});

	test("quoted, escaped and bell forms are refused", () => {
		for (const c of [
			's"ay hi',
			"'s'ay hi",
			'"$X" hi',
			"$'\\x73ay' hi",
			"/usr/bin/s\\ay hi",
			"printf '\\a'",
			"echo -e '\\a'",
		]) {
			expect([c, isAudioCommand(c)]).toEqual([c, true]);
		}
	});

	test("a plain echo that only names the word is left alone", () => {
		expect(isAudioCommand("echo say hi")).toBe(false);
		expect(isAudioCommand("grep say notes.md")).toBe(false);
	});

	test("voice is off with no settings file and no env", async () => {
		const prev = process.env.EIGHT_HOME;
		const dir = mkdtempSync(join(tmpdir(), "s1audio-"));
		process.env.EIGHT_HOME = dir;
		try {
			expect(await voiceIsOn({})).toBe(false);
			expect(await voiceIsOn({ EIGHT_VOICE: "1" })).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.EIGHT_HOME;
			else process.env.EIGHT_HOME = prev;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
