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

export interface PerAgentVoices {
	/** macOS TTS voice for the Orchestrator tab. */
	orchestrator: string;
	/** macOS TTS voice for the Engineer tab. */
	engineer: string;
	/** macOS TTS voice for the QA tab. */
	qa: string;
}

export interface VoiceSettings {
	/** Silence detection threshold in milliseconds. Range 500-5000. */
	silenceThresholdMs: number;
	/** Whether the user can interrupt TTS by speaking. */
	bargeIn: boolean;
	/** macOS TTS voice name (e.g. "Ava", "Samantha"). Used as fallback when no per-agent voice is set. */
	ttsVoice: string;
	/** Whether the agent's text replies are spoken via TTS by default. */
	outputEnabled: boolean;
	/** Per-agent macOS voice overrides. Each tab role gets its own voice. */
	perAgent: PerAgentVoices;
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

export interface AgentNames {
	/** User-friendly display name for the orchestrator role. */
	orchestrator: string;
	/** User-friendly display name for the engineer role. */
	engineer: string;
	/** User-friendly display name for the qa role. */
	qa: string;
}

export interface AgentsSettings {
	/**
	 * Display names for the 3 chat tabs / role-registry roles.
	 * Defaults match the canonical role names ("Orchestrator", "Engineer", "QA").
	 * The user can rename these during onboarding or via `/settings`.
	 *
	 * Consumers (TabBar, status bar, agent system prompt builder) read these
	 * lazily via `resolveRoleName()` so renaming is a soft, display-only change.
	 */
	names: AgentNames;
}

export interface Settings {
	version: 1;
	voice: VoiceSettings;
	performance: PerformanceSettings;
	models: ModelsSettings;
	providers: ProvidersSettings;
	ui: UISettings;
	agents: AgentsSettings;
}

export type SettingsKey = keyof Settings;
