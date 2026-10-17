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
	/**
	 * Push-to-talk voice input. Off unless true (undefined = off). When on, Ctrl+R
	 * opens the mic and Ctrl+R again stops it (toggle, since terminals send no
	 * key-up). Local whisper.cpp only; the transcript lands in the prompt to edit.
	 */
	inputEnabled?: boolean;
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

export interface RetrySettings {
	/**
	 * Retries per model request after a failure. null = built-in default (the
	 * AI SDK's own, or 8 attempts for OpenRouter ":free" models). Valid: whole
	 * number 0-20; anything else falls back to the default.
	 */
	maxRetries: number | null;
	/** Longest wait between two retries after a rate limit, in ms. Valid 1000-600000. Default 30000. */
	maxDelayMs: number;
	/**
	 * A streamed model reply that sends no bytes for this long is torn down, in
	 * ms. null = built-in default (5 minutes; EIGHT_STREAM_IDLE_MS still wins).
	 * Valid 1000-86400000.
	 */
	httpIdleTimeoutMs: number | null;
}

export interface MusicSettings {
	/**
	 * The DJ's volume (0-150, mpv's scale), remembered across tracks and
	 * sessions (#3190). A new track starts here. Mute is never stored.
	 */
	volume: number;
}

export interface ShellSettings {
	/**
	 * Windows only. Full path to the shell run_command uses (bash.exe, pwsh.exe,
	 * cmd.exe). Empty = auto: Git Bash if installed, else PowerShell 7, else cmd.exe.
	 */
	path: string;
	/** Windows only. Offer the model a separate `powershell` tool. Default false. */
	powershellTool: boolean;
}

export interface Settings {
	version: 1;
	voice: VoiceSettings;
	performance: PerformanceSettings;
	models: ModelsSettings;
	providers: ProvidersSettings;
	ui: UISettings;
	agents: AgentsSettings;
	retry: RetrySettings;
	music: MusicSettings;
	shell: ShellSettings;
}

export type SettingsKey = keyof Settings;
