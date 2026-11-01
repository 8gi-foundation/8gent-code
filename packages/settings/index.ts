/**
 * 8gent Code - Settings Package
 *
 * Typed settings store backed by ~/.8gent/settings.json.
 *
 * Usage:
 *   import { loadSettings, saveSettings, getSetting, setSetting } from "@8gent/settings";
 *   const s = loadSettings();
 *   if (s.performance.mode === "lite") { ... }
 *   setSetting("ui", { theme: "amber" });
 */

export type {
	Settings,
	SettingsKey,
	VoiceSettings,
	PerAgentVoices,
	PerformanceSettings,
	PerformanceMode,
	IntroBannerMode,
	ModelsSettings,
	ModelTabsSettings,
	ModelTabSetting,
	ProvidersSettings,
	ProviderEndpoint,
	UISettings,
	ThinkingVisualiserSettings,
	AgentsSettings,
	AgentNames,
	MusicSettings,
	RetrySettings,
	ThinkingModeSettings,
} from "./schema.js";

export { getVoiceForRole } from "./voice.js";
export { resolveRoleName } from "./agents.js";
export { looksLikeSecret, SECRET_NAME_REFUSAL, SECRET_NAME_RESET_NOTICE } from "./secret-guard.js";
export { scrubSecretAgentNames } from "./scrub-names.js";
export type { AgentRoleKey } from "./agents.js";

export { DEFAULT_SETTINGS } from "./defaults.js";

export { resolveRetrySettings, RETRY_LIMITS } from "./retry.js";
export type { ResolvedRetrySettings } from "./retry.js";
export { PROJECT_SETTINGS_ALLOWLIST, filterProjectSettings } from "./project.js";
export type { IgnoredSetting } from "./project.js";

export {
	loadSettings,
	loadGlobalSettings,
	loadSettingsReport,
	saveSettings,
	getSetting,
	setSetting,
	getSettingsFilePath,
} from "./store.js";
