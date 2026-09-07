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
	getVoiceEngine,
	getVoiceForRole,
	isTTSEngineName,
	isVoiceForEngine,
	resolveVoiceForEngine,
} from "./voice.js";

function withVoice(patch: Partial<Settings["voice"]>): Settings {
	return { ...DEFAULT_SETTINGS, voice: { ...DEFAULT_SETTINGS.voice, ...patch } };
}

describe("voice settings defaults", () => {
	test("KittenTTS is the default engine with Kitten voices per role", () => {
		expect(DEFAULT_SETTINGS.voice.engine).toBe("kitten");
		expect(DEFAULT_SETTINGS.voice.perAgent).toEqual({
			orchestrator: "Jasper",
			engineer: "Bruno",
			qa: "Luna",
		});
		expect(DEFAULT_SETTINGS.voice.ttsVoice).toBe("Bella");
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
			fallback: "F2",
		});
		expect(ENGINE_DEFAULT_VOICES.macos).toEqual({
			orchestrator: "Daniel",
			engineer: "Karen",
			qa: "Moira",
			fallback: "Ava",
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
		expect(getVoiceForRole("orchestrator", DEFAULT_SETTINGS)).toBe("Jasper");
		expect(getVoiceForRole("engineer", DEFAULT_SETTINGS)).toBe("Bruno");
		expect(getVoiceForRole("qa", DEFAULT_SETTINGS)).toBe("Luna");
		expect(getVoiceForRole("unknown-role", DEFAULT_SETTINGS)).toBe("Bruno");
	});

	test("an older file with macOS names under the kitten engine gets Kitten defaults", () => {
		const s = withVoice({
			ttsVoice: "Ava",
			perAgent: { orchestrator: "Daniel", engineer: "Karen", qa: "Moira" },
		});
		expect(getVoiceForRole("orchestrator", s)).toBe("Jasper");
		expect(getVoiceForRole("engineer", s)).toBe("Bruno");
		expect(getVoiceForRole("qa", s)).toBe("Luna");
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
		expect(resolveVoiceForEngine("kitten", "Moira", DEFAULT_SETTINGS)).toBe("Bella");
		expect(resolveVoiceForEngine("kitten", null, DEFAULT_SETTINGS)).toBe("Bella");
		expect(resolveVoiceForEngine("macos", "Moira", DEFAULT_SETTINGS)).toBe("Moira");
		expect(resolveVoiceForEngine("macos", undefined, DEFAULT_SETTINGS)).toBe("Ava");
		expect(resolveVoiceForEngine("supertonic", "Moira", DEFAULT_SETTINGS)).toBe("F2");
	});
});
