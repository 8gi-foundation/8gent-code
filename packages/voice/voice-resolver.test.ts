/**
 * Tests for the spoken-voice resolver.
 *
 * The onboarding greeting ("Good day. I'm 8gent, The Infinite Gentleman.")
 * used to go out as a pitch-dropped Moira, then as `say -v Bruno` - a KittenTTS
 * voice name that macOS does not have, so `say` silently substituted another
 * voice. These tests pin the rule that replaced it:
 *   1. The user's settings.json `ttsVoice` is honoured when it is installed.
 *   2. On macOS the default is the system `say` engine with the most natural
 *      installed voice (Premium / Enhanced / Siri-style first).
 *   3. KittenTTS is used only when the user explicitly chose it.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FALLBACK_SYSTEM_VOICE,
	listInstalledSystemVoices,
	parseSayVoiceList,
	pickNaturalSystemVoice,
	resolveSpeechVoice,
} from "./voice-resolver.js";

// Trimmed real `say -v '?'` output shapes, including the novelty voices that
// must never be picked and a Siri-style neural voice.
const STANDARD_ONLY = [
	"Albert              en_US    # Hello! My name is Albert.",
	"Bad News            en_US    # Hello! My name is Bad News.",
	"Daniel              en_GB    # Hello! My name is Daniel.",
	"Eddy (English (US)) en_US    # Hello! My name is Eddy.",
	"Karen               en_AU    # Hello! My name is Karen.",
	"Moira               en_IE    # Hello! My name is Moira.",
	"Samantha            en_US    # Hello! My name is Samantha.",
	"Thomas              fr_FR    # Bonjour, je m’appelle Thomas.",
	"Zarvox              en_US    # Hello! My name is Zarvox.",
].join("\n");

const WITH_PREMIUM = [
	STANDARD_ONLY,
	"Ava (Premium)       en_US    # Hello! My name is Ava.",
	"Serena (Enhanced)   en_GB    # Hello! My name is Serena.",
].join("\n");

const WITH_SIRI = [
	STANDARD_ONLY,
	"Aman (English (India)) en_IN    # Hello! My name is Aman.",
	"Aman (English (India)) en_IN    # Hi, I’m Siri!",
].join("\n");

describe("parseSayVoiceList", () => {
	test("reads names with spaces and parentheses, and the locale", () => {
		const voices = parseSayVoiceList(WITH_PREMIUM);
		const ava = voices.find((v) => v.name === "Ava (Premium)");
		expect(ava).toEqual({ name: "Ava (Premium)", locale: "en_US", quality: "premium" });
		expect(voices.find((v) => v.name === "Serena (Enhanced)")?.quality).toBe("enhanced");
		expect(voices.find((v) => v.name === "Samantha")?.quality).toBe("standard");
	});

	test("marks Siri-style neural voices and de-duplicates them", () => {
		const voices = parseSayVoiceList(WITH_SIRI).filter((v) => v.name.startsWith("Aman"));
		expect(voices).toEqual([{ name: "Aman (English (India))", locale: "en_IN", quality: "siri" }]);
	});

	test("ignores blank and malformed lines", () => {
		expect(parseSayVoiceList("\n  \nnot a voice line\n")).toEqual([]);
	});
});

describe("pickNaturalSystemVoice", () => {
	test("prefers a Premium voice over Enhanced and standard ones", () => {
		expect(pickNaturalSystemVoice(parseSayVoiceList(WITH_PREMIUM), "en_US")).toBe("Ava (Premium)");
	});

	test("prefers a Siri-style neural voice over standard ones in the user's own locale", () => {
		expect(pickNaturalSystemVoice(parseSayVoiceList(WITH_SIRI), "en_IN")).toBe("Aman (English (India))");
	});

	test("a voice from the user's own region beats a better voice with another accent", () => {
		expect(pickNaturalSystemVoice(parseSayVoiceList(WITH_SIRI), "en_US")).toBe("Samantha");
		expect(pickNaturalSystemVoice(parseSayVoiceList(WITH_PREMIUM), "en_GB")).toBe("Serena (Enhanced)");
	});

	test("falls back to a good standard voice, never a novelty one", () => {
		expect(pickNaturalSystemVoice(parseSayVoiceList(STANDARD_ONLY), "en_US")).toBe("Samantha");
	});

	test("with an unknown locale, quality decides", () => {
		expect(pickNaturalSystemVoice(parseSayVoiceList(WITH_SIRI), "")).toBe("Aman (English (India))");
	});

	test("returns null when no usable English voice is installed", () => {
		const only = parseSayVoiceList("Zarvox              en_US    # Hello! My name is Zarvox.");
		expect(pickNaturalSystemVoice(only)).toBeNull();
	});
});

describe("resolveSpeechVoice", () => {
	const installed = parseSayVoiceList(WITH_PREMIUM);

	test("honours settings.json ttsVoice when it is installed", () => {
		expect(resolveSpeechVoice({ platform: "darwin", settingsVoice: "Daniel", installed })).toEqual({
			engine: "system",
			voice: "Daniel",
		});
	});

	test("matches a settings voice to its installed quality variant", () => {
		expect(resolveSpeechVoice({ platform: "darwin", settingsVoice: "ava", installed })).toEqual({
			engine: "system",
			voice: "Ava (Premium)",
		});
	});

	test("a settings voice that is not installed falls through to the natural default", () => {
		const standard = parseSayVoiceList(STANDARD_ONLY);
		expect(
			resolveSpeechVoice({ platform: "darwin", settingsVoice: "Ava", installed: standard }),
		).toEqual({ engine: "system", voice: "Samantha" });
	});

	test("default on darwin is the system engine with a natural voice", () => {
		expect(resolveSpeechVoice({ platform: "darwin", installed })).toEqual({
			engine: "system",
			voice: "Ava (Premium)",
		});
	});

	test("the old Bruno default on the system engine is not passed to say", () => {
		// `say -v Bruno` does not fail: macOS quietly swaps in another voice.
		const standard = parseSayVoiceList(STANDARD_ONLY);
		expect(
			resolveSpeechVoice({
				platform: "darwin",
				preference: { engine: "system", voiceId: "Bruno" },
				installed: standard,
			}),
		).toEqual({ engine: "system", voice: "Samantha" });
	});

	test("an onboarding pick of an installed system voice wins", () => {
		expect(
			resolveSpeechVoice({
				platform: "darwin",
				settingsVoice: "Daniel",
				preference: { engine: "system", voiceId: "Moira" },
				installed,
			}),
		).toEqual({ engine: "system", voice: "Moira" });
	});

	test("KittenTTS only when explicitly chosen", () => {
		expect(
			resolveSpeechVoice({
				platform: "darwin",
				preference: { engine: "kitten", voiceId: "Jasper" },
				installed,
			}),
		).toEqual({ engine: "kitten", voice: "Jasper" });
		// A Kitten voice name alone, without the kitten engine, is not an opt-in.
		expect(
			resolveSpeechVoice({ platform: "darwin", preference: { voiceId: "Bruno" }, installed })
				.engine,
		).toBe("system");
	});

	test("unknown installed list honours the settings voice as-is", () => {
		expect(
			resolveSpeechVoice({ platform: "darwin", settingsVoice: "Daniel", installed: null }),
		).toEqual({ engine: "system", voice: "Daniel" });
		expect(resolveSpeechVoice({ platform: "darwin", installed: null })).toEqual({
			engine: "system",
			voice: FALLBACK_SYSTEM_VOICE,
		});
	});

	test("non-macOS resolves to no speech instead of crashing", () => {
		expect(
			resolveSpeechVoice({
				platform: "linux",
				settingsVoice: "Ava",
				preference: { engine: "kitten", voiceId: "Bruno" },
				installed: null,
			}),
		).toEqual({ engine: "none", voice: null });
	});
});

describe("listInstalledSystemVoices", () => {
	const tmpCache = () => join(mkdtempSync(join(tmpdir(), "voices-")), "system-voices.json");

	test("off macOS resolves to null without reading", async () => {
		let reads = 0;
		const read = async () => {
			reads++;
			return STANDARD_ONLY;
		};
		expect(
			await listInstalledSystemVoices({ platform: "linux", read, cachePath: tmpCache() }),
		).toBeNull();
		expect(reads).toBe(0);
	});

	test("a fresh disk cache is used without running say", async () => {
		const cachePath = tmpCache();
		const voices = parseSayVoiceList(WITH_PREMIUM);
		writeFileSync(cachePath, JSON.stringify({ savedAt: Date.now(), voices }));
		const read = async () => {
			throw new Error("should not read");
		};
		expect(await listInstalledSystemVoices({ platform: "darwin", read, cachePath })).toEqual(
			voices,
		);
	});

	test("with no cache, a quick read is returned and written to disk", async () => {
		const cachePath = tmpCache();
		const read = async () => STANDARD_ONLY;
		const voices = await listInstalledSystemVoices({ platform: "darwin", read, cachePath });
		expect(voices?.map((v) => v.name)).toContain("Samantha");
		expect(JSON.parse(readFileSync(cachePath, "utf8")).voices).toEqual(voices);
	});

	test("a slow first read resolves to null but still fills the cache", async () => {
		const cachePath = tmpCache();
		let finish: (s: string) => void = () => {};
		const read = () => new Promise<string>((r) => (finish = r));
		expect(
			await listInstalledSystemVoices({ platform: "darwin", read, cachePath, waitMs: 10 }),
		).toBeNull();
		finish(STANDARD_ONLY);
		await new Promise((r) => setTimeout(r, 20));
		expect(JSON.parse(readFileSync(cachePath, "utf8")).voices.length).toBeGreaterThan(0);
	});
});
