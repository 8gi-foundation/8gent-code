/**
 * 8gent Code - Voice helpers
 *
 * Resolves the macOS TTS voice for a given tab role from the live settings file.
 * Roles map 1:1 onto the per-tab agent setup wired in
 * `apps/tui/src/hooks/useWorkspaceTabs.ts` (orchestrator / engineer / qa).
 *
 * The lookup is intentionally tolerant:
 *   1. If `voice.perAgent[role]` is a non-empty string, use it.
 *   2. Otherwise, fall back to `voice.ttsVoice` (the existing single-voice setting).
 *   3. Otherwise, fall back to the documented default for that role.
 */

import { DEFAULT_SETTINGS } from "./defaults.js";
import type { PerAgentVoices, Settings } from "./schema.js";
import { loadSettings } from "./store.js";

export type AgentRole = keyof PerAgentVoices;

const KNOWN_ROLES: AgentRole[] = ["orchestrator", "engineer", "qa"];

/**
 * Resolve the macOS TTS voice for a given role.
 *
 * Pass `settings` explicitly when you already have a snapshot — otherwise the
 * helper reads from `~/.8gent/settings.json` so callers don't have to.
 */
export function getVoiceForRole(
	role: string,
	settings?: Settings,
): string {
	const s = settings ?? loadSettings();
	const safeRole: AgentRole = (KNOWN_ROLES as readonly string[]).includes(role)
		? (role as AgentRole)
		: "engineer";

	const perAgent = s.voice?.perAgent?.[safeRole];
	if (typeof perAgent === "string" && perAgent.trim().length > 0) {
		return perAgent;
	}

	const fallback = s.voice?.ttsVoice;
	if (typeof fallback === "string" && fallback.trim().length > 0) {
		return fallback;
	}

	return DEFAULT_SETTINGS.voice.perAgent[safeRole];
}
