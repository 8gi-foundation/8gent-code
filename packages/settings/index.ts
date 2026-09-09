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
} from "./schema.js";

export { getVoiceForRole } from "./voice.js";
export { resolveRoleName } from "./agents.js";
export type { AgentRoleKey } from "./agents.js";

export { DEFAULT_SETTINGS } from "./defaults.js";

export {
	loadSettings,
	saveSettings,
	getSetting,
	setSetting,
	getSettingsFilePath,
} from "./store.js";

export {
	clampNumber,
	numberRuleMessage,
	textRuleMessage,
	validateNumber,
	validateText,
} from "./validate.js";
export type { NumberRule, TextRule, TextRuleKind, ValidationResult } from "./validate.js";
