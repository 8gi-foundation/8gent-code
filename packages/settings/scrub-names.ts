/**
 * Startup scrub: a saved agent name that looks like a key is replaced with the
 * role default (the same fallback resolveRoleName uses). Returns true when
 * something was reset, so the caller shows SECRET_NAME_RESET_NOTICE once.
 * Never throws, never returns or logs the value.
 */
import { DEFAULT_SETTINGS } from "./defaults.js";
import { looksLikeSecret } from "./secret-guard.js";
import { loadGlobalSettings, saveSettings } from "./store.js";

const ROLES = ["orchestrator", "engineer", "qa"] as const;

export function scrubSecretAgentNames(): boolean {
	try {
		const current = loadGlobalSettings();
		const names = { ...current.agents.names };
		let hit = false;
		for (const role of ROLES) {
			if (looksLikeSecret(names[role])) {
				names[role] = DEFAULT_SETTINGS.agents.names[role];
				hit = true;
			}
		}
		if (hit) saveSettings({ ...current, agents: { ...current.agents, names } });
		return hit;
	} catch {
		return false;
	}
}
