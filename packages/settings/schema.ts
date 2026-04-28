/**
 * 8gent Code - Settings Schema
 *
 * Canonical typed shape for ~/.8gent/settings.json.
 * Versioned for forward-compatible migrations.
 *
 * IMPORTANT: This shape is shared across multiple consumers (TUI Settings view,
 * agent runtime, voice auto-adjust). Do NOT change keys or types without
 * bumping `version` and adding a migration path.
 */

export interface VoiceSettings {
	/** Silence detection threshold in milliseconds. Range 500-5000. */
	silenceThresholdMs: number;
	/** Whether the user can interrupt TTS by speaking. */
	bargeIn: boolean;
	/** macOS TTS voice name (e.g. "Ava", "Samantha"). */
	ttsVoice: string;
}

export type PerformanceMode = "auto" | "lite" | "full";
export type IntroBannerMode = "auto" | "on" | "off";

export interface PerformanceSettings {
	/**
	 * "auto" — honor existing env var detection (8GENT_LITE / 8GENT_FULL).
	 * "lite" — force lite mode.
	 * "full" — force full mode (kernel, heartbeats, AST pre-index, etc.).
	 */
	mode: PerformanceMode;
	/**
	 * "auto" — honor existing env vars + show by default.
	 * "on"   — always show intro banner.
	 * "off"  — never show intro banner.
	 */
	introBanner: IntroBannerMode;
}

export interface ModelTabSetting {
	provider: string;
	model: string;
}

export interface ModelTabsSettings {
	orchestrator: ModelTabSetting;
	engineer: ModelTabSetting;
	qa: ModelTabSetting;
}

export interface ModelsSettings {
	tabs: ModelTabsSettings;
}

export interface ProviderEndpoint {
	baseURL: string;
}

export interface ProvidersSettings {
	apfel: ProviderEndpoint;
	ollama: ProviderEndpoint;
	lmstudio: ProviderEndpoint;
	openrouter: ProviderEndpoint;
}

export interface ThinkingVisualiserSettings {
	/** Master toggle. Default true. */
	enabled: boolean;
	/** Operator rotation interval in ms. Default 8000. */
	operatorRotationMs: number;
	/** Idle threshold (ms) before a boredom mutation fires. Default 30000. */
	boredomThresholdMs: number;
}

export interface UISettings {
	/** Reserved for future themes. Defaults to "amber". */
	theme: string;
	/** Procedural Thinking-box visualiser configuration. */
	thinkingVisualiser: ThinkingVisualiserSettings;
}

export interface Settings {
	version: 1;
	voice: VoiceSettings;
	performance: PerformanceSettings;
	models: ModelsSettings;
	providers: ProvidersSettings;
	ui: UISettings;
}

export type SettingsKey = keyof Settings;
