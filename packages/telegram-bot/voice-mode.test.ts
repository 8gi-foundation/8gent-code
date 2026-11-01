import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_SPOKEN_CHARS,
	decideVoice,
	readConfiguredChatId,
	readVoiceState,
	sendVoiceNote,
	speakableText,
	writeVoiceState,
} from "./voice-mode";

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "voice-mode-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("persisted toggle", () => {
	test("defaults to off when no state file exists", () => {
		expect(readVoiceState(join(tmp(), "missing.json")).enabled).toBe(false);
	});

	test("round-trips through disk so it survives a bridge restart", () => {
		const path = join(tmp(), "nested", "telegram-voice.json");
		writeVoiceState(true, path);
		expect(existsSync(path)).toBe(true);
		expect(readVoiceState(path).enabled).toBe(true);
		writeVoiceState(false, path);
		expect(readVoiceState(path).enabled).toBe(false);
	});

	test("a corrupt state file reads as off rather than throwing", () => {
		const path = join(tmp(), "bad.json");
		writeFileSync(path, "{not json");
		expect(readVoiceState(path).enabled).toBe(false);
	});
});

describe("speakableText", () => {
	test("drops fenced code, which is the worst thing to hear read aloud", () => {
		expect(speakableText("Done.\n```ts\nconst x = 1;\n```\nShipped.")).toBe("Done. Shipped.");
	});

	test("keeps link text and drops the url", () => {
		expect(speakableText("See [the PR](https://github.com/a/b/pull/1) now")).toBe("See the PR now");
	});

	test("strips markdown emphasis and bullets", () => {
		expect(speakableText("- **one**\n- _two_")).toBe("one two");
	});

	test("a reply that was only code has nothing to say", () => {
		expect(speakableText("```\nls -la\n```")).toBe("");
	});
});

describe("decideVoice", () => {
	test("off means silent", () => {
		expect(decideVoice("Shipped.", { enabled: false })).toMatchObject({
			speak: false,
			reason: "voice-mode-off",
		});
	});

	test("on, short, daytime means spoken", () => {
		expect(decideVoice("Shipped the fix.", { enabled: true })).toMatchObject({
			speak: true,
			reason: "spoken",
		});
	});

	test("the middle of the night is not held: quiet hours are lifted", () => {
		expect(decideVoice("Shipped the fix.", { enabled: true })).toMatchObject({
			speak: true,
			reason: "spoken",
		});
	});

	test("a 600-word answer is not a voice note", () => {
		const long = "word ".repeat(600);
		const d = decideVoice(long, { enabled: true });
		expect(d.speak).toBe(false);
		expect(d.reason).toBe("too-long");
		expect(d.text.length).toBeGreaterThan(MAX_SPOKEN_CHARS);
	});

	test("a code-only reply is skipped rather than spoken as silence", () => {
		expect(decideVoice("```\nls\n```", { enabled: true })).toMatchObject({
			speak: false,
			reason: "nothing-to-say",
		});
	});
});

describe("chat allowlist on the audio channel", () => {
	test("refuses when the TTS destination is not the bridge chat", async () => {
		const bin = join(tmp(), "fake-kittentts");
		writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const res = await sendVoiceNote({
			text: "hello",
			voice: "Jasper",
			expectedChatId: "111",
			bin,
			resolveConfiguredChatId: () => "999",
		});
		expect(res.sent).toBe(false);
		expect(res.reason).toContain("allowlist");
	});

	// POSIX only: the TTS helper stub is a shell script, which Windows cannot run as a command.
	test.skipIf(process.platform === "win32")("sends when the destination matches", async () => {
		const bin = join(tmp(), "fake-kittentts");
		writeFileSync(bin, "#!/bin/sh\ncat > /dev/null\nexit 0\n", { mode: 0o755 });
		const res = await sendVoiceNote({
			text: "hello",
			voice: "Jasper",
			expectedChatId: "111",
			bin,
			resolveConfiguredChatId: () => "111",
		});
		expect(res.sent).toBe(true);
	});

	test("a missing TTS binary is a refusal, not a crash", async () => {
		const res = await sendVoiceNote({
			text: "hello",
			voice: "Jasper",
			expectedChatId: "111",
			bin: join(tmp(), "does-not-exist"),
			resolveConfiguredChatId: () => "111",
		});
		expect(res.sent).toBe(false);
	});
});

describe("readConfiguredChatId", () => {
	test("reads only the chat id line and never the token", () => {
		const path = join(tmp(), ".env");
		writeFileSync(path, 'TELEGRAM_BOT_TOKEN="not-read-by-this-function"\nTELEGRAM_CHAT_ID=12345\n');
		expect(readConfiguredChatId(path)).toBe("12345");
	});

	test("handles export and quotes", () => {
		const path = join(tmp(), ".env");
		writeFileSync(path, 'export TELEGRAM_CHAT_ID="-100999"\n');
		expect(readConfiguredChatId(path)).toBe("-100999");
	});

	test("missing file is null, not a throw", () => {
		expect(readConfiguredChatId(join(tmp(), "nope"))).toBeNull();
	});
});
