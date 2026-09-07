/**
 * 8gent Code - Voice helpers
 *
 * Resolves the TTS engine and the voice for a given tab role from the live
 * settings file. Roles map 1:1 onto the per-tab agent setup wired in
 * `apps/tui/src/hooks/useWorkspaceTabs.ts` (orchestrator / engineer / qa).
 *
 * Voice names are engine-specific: "Jasper" is a KittenTTS voice, "M1" is a
 * Supertonic voice, "Daniel" is a macOS voice. A settings file written for one
 * engine can carry names the active engine does not know (an older file with
 * macOS names, or a hand edit), so every lookup validates the name against the
 * engine's voice list and falls back to that engine's documented default.
 *
 * The lookup is intentionally tolerant:
 *   1. If `voice.perAgent[role]` is a voice of the active engine, use it.
 *   2. Otherwise, if `voice.ttsVoice` is a voice of the active engine, use it.
 *   3. Otherwise, use the engine's documented default for that role.
 */

import type { PerAgentVoices, Settings, TTSEngineName } from "./schema.js";
import { loadSettings } from "./store.js";

export type AgentRole = keyof PerAgentVoices;

const KNOWN_ROLES: AgentRole[] = ["orchestrator", "engineer", "qa"];

export const TTS_ENGINE_NAMES: readonly TTSEngineName[] = [
	"kitten",
	"supertonic",
	"macos",
] as const;

/** Voices each engine can speak with. Kitten and Supertonic lists are fixed by the model. */
export const ENGINE_VOICES: Record<TTSEngineName, readonly string[]> = {
	kitten: ["Bella", "Jasper", "Luna", "Bruno", "Rosie", "Hugo", "Kiki", "Leo"],
	supertonic: ["M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5"],
	// macOS ships many more; these are the ones the settings screen and the
	// onboarding picker offer. Any installed `say` voice is accepted too, see
	// isVoiceForEngine.
	macos: ["Ava", "Daniel", "Karen", "Moira", "Samantha", "Alex", "Rishi"],
};

/** Per-engine defaults: one voice per tab role plus the single-voice fallback. */
export const ENGINE_DEFAULT_VOICES: Record<
	TTSEngineName,
	PerAgentVoices & { fallback: string }
> = {
	kitten: { orchestrator: "Jasper", engineer: "Bruno", qa: "Luna", fallback: "Bella" },
	supertonic: { orchestrator: "M1", engineer: "M2", qa: "F1", fallback: "F2" },
	macos: { orchestrator: "Daniel", engineer: "Karen", qa: "Moira", fallback: "Ava" },
};

/** True when `name` is one of the engine names the settings schema allows. */
export function isTTSEngineName(name: unknown): name is TTSEngineName {
	return typeof name === "string" && (TTS_ENGINE_NAMES as readonly string[]).includes(name);
}

/**
 * True when `voice` is a name the given engine can speak with.
 *
 * Kitten and Supertonic have fixed voice lists. macOS accepts any non-empty
 * name that is not a Kitten or Supertonic voice, because the installed `say`
 * voices vary per machine (the settings screen offers the common ones) while
 * a neural voice name handed to `say` is always a leftover from another engine.
 */
export function isVoiceForEngine(engine: TTSEngineName, voice: unknown): voice is string {
	if (typeof voice !== "string") return false;
	const trimmed = voice.trim();
	if (trimmed.length === 0) return false;
	if (engine === "macos") {
		return !ENGINE_VOICES.kitten.includes(trimmed) && !ENGINE_VOICES.supertonic.includes(trimmed);
	}
	return ENGINE_VOICES[engine].includes(trimmed);
}

/**
 * Resolve the TTS engine from settings. Unknown or missing values resolve to
 * "kitten", the documented default, so a hand-edited file never breaks speech.
 */
export function getVoiceEngine(settings?: Settings): TTSEngineName {
	const s = settings ?? loadSettings();
	const engine = s.voice?.engine;
	return isTTSEngineName(engine) ? engine : "kitten";
}

/**
 * Pick `preferred` when it is a voice of `engine`, otherwise the engine's
 * single-voice fallback from settings, otherwise the engine's documented
 * fallback. Used for one-off overrides such as the onboarding voice pick.
 */
export function resolveVoiceForEngine(
	engine: TTSEngineName,
	preferred: string | null | undefined,
	settings?: Settings,
): string {
	if (isVoiceForEngine(engine, preferred)) return preferred.trim();
	const s = settings ?? loadSettings();
	const fallback = s.voice?.ttsVoice;
	if (isVoiceForEngine(engine, fallback)) return fallback.trim();
	return ENGINE_DEFAULT_VOICES[engine].fallback;
}

/**
 * Resolve the TTS voice for a given role on the active engine.
 *
 * Pass `settings` explicitly when you already have a snapshot; otherwise the
 * helper reads from `~/.8gent/settings.json` so callers don't have to.
 */
export function getVoiceForRole(role: string, settings?: Settings): string {
	const s = settings ?? loadSettings();
	const safeRole: AgentRole = (KNOWN_ROLES as readonly string[]).includes(role)
		? (role as AgentRole)
		: "engineer";
	const engine = getVoiceEngine(s);

	const perAgent = s.voice?.perAgent?.[safeRole];
	if (isVoiceForEngine(engine, perAgent)) return perAgent.trim();

	const fallback = s.voice?.ttsVoice;
	if (isVoiceForEngine(engine, fallback)) return fallback.trim();

	return ENGINE_DEFAULT_VOICES[engine][safeRole];
}
