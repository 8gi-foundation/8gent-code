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
export const ENGINE_DEFAULT_VOICES: Record<TTSEngineName, PerAgentVoices & { fallback: string }> = {
	// The single-voice fallback is the deep male voice on every engine: it is
	// what a new user hears in the intro and for every reply until they pick
	// something else. On Kitten that is Bruno, measured at about 108 Hz mean
	// pitch against Jasper 137, Hugo 159 and Leo 166. Each role then gets a
	// different voice so two agents never sound alike.
	kitten: { orchestrator: "Bruno", engineer: "Jasper", qa: "Hugo", fallback: "Bruno" },
	supertonic: { orchestrator: "M1", engineer: "M2", qa: "F1", fallback: "M1" },
	macos: { orchestrator: "Daniel", engineer: "Karen", qa: "Moira", fallback: "Daniel" },
};

/**
 * Voice order used to give a tab beyond the three named roles its own voice.
 * The three role defaults come first so the rotation never hands out a voice
 * an agent already owns; the rest follow in the engine's own order.
 */
export function voiceRotation(engine: TTSEngineName): string[] {
	const d = ENGINE_DEFAULT_VOICES[engine];
	const first = [d.orchestrator, d.engineer, d.qa];
	const rest = ENGINE_VOICES[engine].filter((v) => !first.includes(v));
	return [...first, ...rest];
}

/** Stable small hash so the same tab keeps the same voice across restarts. */
function stableIndex(key: string, span: number): number {
	if (span <= 0) return 0;
	let h = 0;
	for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
	return h % span;
}

/**
 * A voice for a tab that is not one of the three named roles (a second chat
 * tab, say). Never returns a voice one of the roles already uses, so every
 * agent on screen sounds different. Deterministic: the same key always maps
 * to the same voice.
 */
export function voiceForExtraTab(engine: TTSEngineName, key: string): string {
	const rotation = voiceRotation(engine);
	const spare = rotation.slice(3);
	if (spare.length === 0) return rotation[rotation.length - 1];
	return spare[stableIndex(key, spare.length)];
}

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

/** A voice the user picked, and who it is for. */
export interface VoiceChoice {
	engine: TTSEngineName;
	voice: string;
	/** "all" sets every role; a role sets that role only. */
	scope: "all" | AgentRole;
}

/**
 * Apply a voice pick to a settings snapshot and return the new snapshot.
 *
 * - scope "all": the engine, the fallback voice and all three roles become
 *   the chosen voice.
 * - scope role: that role becomes the chosen voice. When the pick is on a
 *   different engine than settings hold, the engine switches with it and
 *   the other roles reset to that engine's documented defaults, because a
 *   name from the old engine would otherwise be silently replaced at speak
 *   time by getVoiceForRole. The caller reports the reset to the user.
 *
 * A voice the engine does not know is replaced by the engine's fallback so
 * a bad pick can never write an unspeakable name.
 */
export function applyVoiceChoice(settings: Settings, choice: VoiceChoice): Settings {
	const engine = isTTSEngineName(choice.engine) ? choice.engine : "kitten";
	const voice = isVoiceForEngine(engine, choice.voice)
		? choice.voice.trim()
		: ENGINE_DEFAULT_VOICES[engine].fallback;
	const current = settings.voice;
	if (choice.scope === "all") {
		return {
			...settings,
			voice: {
				...current,
				engine,
				ttsVoice: voice,
				perAgent: { orchestrator: voice, engineer: voice, qa: voice },
			},
		};
	}
	const role: AgentRole = (KNOWN_ROLES as readonly string[]).includes(choice.scope)
		? choice.scope
		: "engineer";
	const engineChanged = getVoiceEngine(settings) !== engine;
	const defaults = ENGINE_DEFAULT_VOICES[engine];
	const base: PerAgentVoices = engineChanged
		? { orchestrator: defaults.orchestrator, engineer: defaults.engineer, qa: defaults.qa }
		: { ...current.perAgent };
	return {
		...settings,
		voice: {
			...current,
			engine,
			ttsVoice: engineChanged ? voice : current.ttsVoice,
			perAgent: { ...base, [role]: voice },
		},
	};
}

/**
 * Resolve the TTS voice for a given role on the active engine.
 *
 * Pass `settings` explicitly when you already have a snapshot; otherwise the
 * helper reads from `~/.8gent/settings.json` so callers don't have to.
 */
export function getVoiceForRole(role: string, settings?: Settings): string {
	const s = settings ?? loadSettings();
	const engine = getVoiceEngine(s);
	const known = (KNOWN_ROLES as readonly string[]).includes(role);
	// A tab that is not one of the three named roles gets its own voice rather
	// than borrowing the engineer's, so two tabs speaking never sound the same.
	if (!known) {
		const key = role?.trim();
		if (key) return voiceForExtraTab(engine, key);
	}
	const safeRole: AgentRole = known ? (role as AgentRole) : "engineer";

	const perAgent = s.voice?.perAgent?.[safeRole];
	if (isVoiceForEngine(engine, perAgent)) return perAgent.trim();

	const fallback = s.voice?.ttsVoice;
	if (isVoiceForEngine(engine, fallback)) return fallback.trim();

	return ENGINE_DEFAULT_VOICES[engine][safeRole];
}
