/**
 * Tests for engine-aware voice settings: defaults, per-engine voice validation
 * and the fallbacks that keep an older settings file speaking.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "./defaults.js";
import type { Settings } from "./schema.js";
import {
	ENGINE_DEFAULT_VOICES,
	ENGINE_VOICES,
	TTS_ENGINE_NAMES,
	getVoiceEngine,
	getVoiceForRole,
	isTTSEngineName,
	isVoiceForEngine,
	resolveVoiceForEngine,
	voiceForExtraTab,
	voiceRotation,
} from "./voice.js";

function withVoice(patch: Partial<Settings["voice"]>): Settings {
	return { ...DEFAULT_SETTINGS, voice: { ...DEFAULT_SETTINGS.voice, ...patch } };
}

describe("voice settings defaults", () => {
	test("KittenTTS is the default engine with Kitten voices per role", () => {
		expect(DEFAULT_SETTINGS.voice.engine).toBe("kitten");
		expect(DEFAULT_SETTINGS.voice.perAgent).toEqual({
			orchestrator: "Bruno",
			engineer: "Jasper",
			qa: "Hugo",
		});
		// The deep male voice is what a new user hears until they pick another.
		expect(DEFAULT_SETTINGS.voice.ttsVoice).toBe("Bruno");
		expect(DEFAULT_SETTINGS.voice.outputEnabled).toBe(true);
	});

	test("every engine default is a voice of that engine", () => {
		for (const engine of ["kitten", "supertonic", "macos"] as const) {
			const d = ENGINE_DEFAULT_VOICES[engine];
			for (const v of [d.orchestrator, d.engineer, d.qa, d.fallback]) {
				expect(ENGINE_VOICES[engine]).toContain(v);
			}
		}
		expect(ENGINE_DEFAULT_VOICES.supertonic).toEqual({
			orchestrator: "M1",
			engineer: "M2",
			qa: "F1",
			fallback: "M1",
		});
		expect(ENGINE_DEFAULT_VOICES.macos).toEqual({
			orchestrator: "Daniel",
			engineer: "Karen",
			qa: "Moira",
			fallback: "Daniel",
		});
	});
});

describe("engine and voice validation", () => {
	test("isTTSEngineName accepts only the three engines", () => {
		expect(isTTSEngineName("kitten")).toBe(true);
		expect(isTTSEngineName("supertonic")).toBe(true);
		expect(isTTSEngineName("macos")).toBe(true);
		expect(isTTSEngineName("say")).toBe(false);
		expect(isTTSEngineName(undefined)).toBe(false);
	});

	test("getVoiceEngine falls back to kitten for unknown values", () => {
		expect(getVoiceEngine(DEFAULT_SETTINGS)).toBe("kitten");
		expect(getVoiceEngine(withVoice({ engine: "macos" }))).toBe("macos");
		expect(getVoiceEngine(withVoice({ engine: "eleven" as never }))).toBe("kitten");
	});

	test("isVoiceForEngine is strict for neural engines and open for macOS", () => {
		expect(isVoiceForEngine("kitten", "Jasper")).toBe(true);
		expect(isVoiceForEngine("kitten", "Daniel")).toBe(false);
		expect(isVoiceForEngine("supertonic", "F3")).toBe(true);
		expect(isVoiceForEngine("supertonic", "Bella")).toBe(false);
		expect(isVoiceForEngine("macos", "Fiona")).toBe(true);
		expect(isVoiceForEngine("macos", "Jasper")).toBe(false);
		expect(isVoiceForEngine("macos", "M1")).toBe(false);
		expect(isVoiceForEngine("macos", "  ")).toBe(false);
		expect(isVoiceForEngine("kitten", 42)).toBe(false);
	});
});

describe("getVoiceForRole", () => {
	test("returns the per-role Kitten voice by default", () => {
		expect(getVoiceForRole("orchestrator", DEFAULT_SETTINGS)).toBe("Bruno");
		expect(getVoiceForRole("engineer", DEFAULT_SETTINGS)).toBe("Jasper");
		expect(getVoiceForRole("qa", DEFAULT_SETTINGS)).toBe("Hugo");
		// An unnamed tab gets a voice of its own, not one of the three above.
		const extra = getVoiceForRole("unknown-role", DEFAULT_SETTINGS);
		expect(["Bruno", "Jasper", "Hugo"]).not.toContain(extra);
	});

	test("an older file with macOS names under the kitten engine gets Kitten defaults", () => {
		const s = withVoice({
			ttsVoice: "Ava",
			perAgent: { orchestrator: "Daniel", engineer: "Karen", qa: "Moira" },
		});
		expect(getVoiceForRole("orchestrator", s)).toBe("Bruno");
		expect(getVoiceForRole("engineer", s)).toBe("Jasper");
		expect(getVoiceForRole("qa", s)).toBe("Hugo");
	});

	test("the macOS engine keeps macOS names", () => {
		const s = withVoice({
			engine: "macos",
			ttsVoice: "Ava",
			perAgent: { orchestrator: "Daniel", engineer: "Karen", qa: "Moira" },
		});
		expect(getVoiceForRole("orchestrator", s)).toBe("Daniel");
		expect(getVoiceForRole("engineer", s)).toBe("Karen");
		expect(getVoiceForRole("qa", s)).toBe("Moira");
	});

	test("falls through per-agent, then ttsVoice, then the engine default", () => {
		const viaFallback = withVoice({
			ttsVoice: "Rosie",
			perAgent: { orchestrator: "", engineer: "Bruno", qa: "Nope" },
		});
		expect(getVoiceForRole("orchestrator", viaFallback)).toBe("Rosie");
		expect(getVoiceForRole("qa", viaFallback)).toBe("Rosie");
		expect(getVoiceForRole("engineer", viaFallback)).toBe("Bruno");

		const viaDefault = withVoice({
			engine: "supertonic",
			ttsVoice: "Bella",
			perAgent: { orchestrator: "Jasper", engineer: "M4", qa: "" },
		});
		expect(getVoiceForRole("orchestrator", viaDefault)).toBe("M1");
		expect(getVoiceForRole("engineer", viaDefault)).toBe("M4");
		expect(getVoiceForRole("qa", viaDefault)).toBe("F1");
	});
});

describe("resolveVoiceForEngine", () => {
	test("keeps a valid override and replaces an invalid one", () => {
		expect(resolveVoiceForEngine("kitten", "Luna", DEFAULT_SETTINGS)).toBe("Luna");
		expect(resolveVoiceForEngine("kitten", "Moira", DEFAULT_SETTINGS)).toBe("Bruno");
		expect(resolveVoiceForEngine("kitten", null, DEFAULT_SETTINGS)).toBe("Bruno");
		expect(resolveVoiceForEngine("macos", "Moira", DEFAULT_SETTINGS)).toBe("Moira");
		expect(resolveVoiceForEngine("macos", undefined, DEFAULT_SETTINGS)).toBe("Daniel");
		expect(resolveVoiceForEngine("supertonic", "Moira", DEFAULT_SETTINGS)).toBe("M1");
	});
});

describe("a deep male default and a voice per agent (#2942)", () => {
	test("the single-voice fallback is the deep male voice on every engine", () => {
		// Bruno measured about 108 Hz against Jasper 137, Hugo 159, Leo 166.
		expect(ENGINE_DEFAULT_VOICES.kitten.fallback).toBe("Bruno");
		expect(ENGINE_DEFAULT_VOICES.supertonic.fallback).toBe("M1");
		expect(ENGINE_DEFAULT_VOICES.macos.fallback).toBe("Daniel");
	});

	test("the shipped defaults give the three agents three different voices", () => {
		for (const engine of TTS_ENGINE_NAMES) {
			const d = ENGINE_DEFAULT_VOICES[engine];
			const roles = [d.orchestrator, d.engineer, d.qa];
			expect(new Set(roles).size).toBe(3);
			// Every default is a voice the engine can actually speak.
			for (const v of roles) expect(isVoiceForEngine(engine, v)).toBe(true);
		}
	});

	test("the orchestrator, the one you hear first, uses the deep voice", () => {
		expect(ENGINE_DEFAULT_VOICES.kitten.orchestrator).toBe("Bruno");
	});

	test("the rotation starts with the three role voices and adds the rest", () => {
		const rot = voiceRotation("kitten");
		expect(rot.slice(0, 3)).toEqual(["Bruno", "Jasper", "Hugo"]);
		expect(new Set(rot).size).toBe(rot.length);
		expect(rot.length).toBe(ENGINE_VOICES.kitten.length);
	});

	test("an extra tab never borrows a voice one of the agents already owns", () => {
		const roles = new Set(["Bruno", "Jasper", "Hugo"]);
		for (const key of ["tab-2", "tab-3", "chat-abc", "9f2a", ""]) {
			if (!key) continue;
			expect(roles.has(voiceForExtraTab("kitten", key))).toBe(false);
		}
	});

	test("the same tab keeps its voice, so it does not change between restarts", () => {
		expect(voiceForExtraTab("kitten", "tab-7")).toBe(voiceForExtraTab("kitten", "tab-7"));
	});

	test("an unnamed tab gets its own voice instead of the engineer's", () => {
		const settings = withVoice({ engine: "kitten" });
		const engineer = getVoiceForRole("engineer", settings);
		expect(getVoiceForRole("tab-2", settings)).not.toBe(engineer);
		// The three named roles still resolve to their own defaults.
		expect(getVoiceForRole("orchestrator", settings)).toBe("Bruno");
	});
});
