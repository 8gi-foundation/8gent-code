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

/**
 * Which local TTS engine speaks agent replies.
 *
 * - "kitten": KittenTTS (local neural, Python). The default.
 * - "supertonic": Supertonic (local neural, Python). Optional; used only when importable.
 * - "macos": the built-in `say` command. Always available on macOS; the fallback
 *   for the other two when their Python package is missing.
 */
export type TTSEngineName = "kitten" | "supertonic" | "macos";

export interface PerAgentVoices {
	/** TTS voice for the Orchestrator tab. Must be a voice of the active engine. */
	orchestrator: string;
	/** TTS voice for the Engineer tab. Must be a voice of the active engine. */
	engineer: string;
	/** TTS voice for the QA tab. Must be a voice of the active engine. */
	qa: string;
}

export interface VoiceSettings {
	/** Silence detection threshold in milliseconds. Range 500-5000. */
	silenceThresholdMs: number;
	/** Whether the user can interrupt TTS by speaking. */
	bargeIn: boolean;
	/** Local TTS engine used for spoken replies. See TTSEngineName. */
	engine: TTSEngineName;
	/**
	 * TTS voice name used as fallback when no per-agent voice is set.
	 * Must be a voice of the active engine (e.g. "Bella" for kitten,
	 * "F1" for supertonic, "Ava" for macos).
	 */
	ttsVoice: string;
	/** Whether the agent's text replies are spoken via TTS by default. */
	outputEnabled: boolean;
	/** Per-agent voice overrides. Each tab role gets its own voice. */
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
	/**
	 * Optional path to an audio file played once on TUI launch during the
	 * intro splash. Empty string = silent (default). macOS only — uses the
	 * built-in `afplay` so no extra deps. Drop a file at
	 * `~/.8gent/sounds/intro.mp3` (or anywhere) and set this path to play it.
	 * Fire-and-forget; never blocks the banner reveal.
	 */
	introSound: string;
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
