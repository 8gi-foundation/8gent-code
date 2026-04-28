/**
 * 8gent Code - Agent name helpers
 *
 * Resolves the user-facing display name for a given role. Mirrors
 * `voice.ts`: a role like "orchestrator" / "engineer" / "qa" maps to
 * `settings.agents.names[role]`, with a sensible fallback chain so
 * renaming is always safe.
 *
 * Lookup order:
 *   1. `settings.agents.names[role]` if set and non-empty
 *   2. Default name from DEFAULT_SETTINGS for that role
 *   3. The capitalized role string (last-resort safety net)
 *
 * Why a separate helper: TabBar, status bar, and the role-registry
 * system-prompt builder all need to read the chosen name lazily. Going
 * through one resolver keeps display behavior consistent and means
 * "rename a role" is one settings write, not a code change.
 */

import { DEFAULT_SETTINGS } from "./defaults.js";
import type { AgentNames, Settings } from "./schema.js";
import { loadSettings } from "./store.js";

export type AgentRoleKey = keyof AgentNames;

const KNOWN_ROLES: AgentRoleKey[] = ["orchestrator", "engineer", "qa"];

function isKnownRole(role: string): role is AgentRoleKey {
	return (KNOWN_ROLES as readonly string[]).includes(role);
}

function capitalize(s: string): string {
	if (!s) return s;
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Resolve the display name for a role.
 *
 * Pass `settings` explicitly when you already have a snapshot — otherwise
 * the helper reads from `~/.8gent/settings.json`.
 */
export function resolveRoleName(role: string, settings?: Settings): string {
	const s = settings ?? loadSettings();

	if (isKnownRole(role)) {
		const chosen = s.agents?.names?.[role];
		if (typeof chosen === "string" && chosen.trim().length > 0) {
			return chosen.trim();
		}
		return DEFAULT_SETTINGS.agents.names[role];
	}

	// Unknown role: don't crash. Use the role string itself, capitalized.
	return capitalize(role) || "Agent";
}
