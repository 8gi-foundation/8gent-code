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
} from "./schema.js";

export { DEFAULT_SETTINGS } from "./defaults.js";

export {
	loadSettings,
	saveSettings,
	getSetting,
	setSetting,
	getSettingsFilePath,
} from "./store.js";
