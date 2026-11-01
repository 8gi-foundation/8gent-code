/**
 * 8gent Code - Auto-tune detection
 *
 * Pure, deterministic detection logic that fills sensible auto-values when
 * the user has chosen "auto" in `~/.8gent/settings.json`. No network, no LLM
 * judging - just if/else against env vars and TTY state.
 *
 * Sibling PR ships the in-TUI Settings View + persistence layer that owns
 * `~/.8gent/settings.json`. This module only consumes the resolved Settings
 * shape and returns effective overrides.
 *
 * TODO: switch to `import type { Settings } from "@8gent/settings"` once the
 * sibling PR lands. For now we inline the schema verbatim from the spec.
 */

// ─── Settings schema (inlined until @8gent/settings package lands) ──────────
export interface Settings {
	version: 1;
	voice: {
		silenceThresholdMs: number;
		bargeIn: boolean;
		ttsVoice: string;
	};
	performance: {
		mode: "auto" | "lite" | "full";
		introBanner: "auto" | "on" | "off";
	};
	models: {
		tabs: Record<
			"orchestrator" | "engineer" | "qa",
			{ provider: string; model: string }
		>;
	};
	providers: Record<
		"apfel" | "ollama" | "lmstudio" | "openrouter",
		{ baseURL: string }
	>;
	ui: { theme: string };
}

// ─── Public API ─────────────────────────────────────────────────────────────
export interface AutoTuneOverrides {
	/** Effective lite mode after applying auto-detection. */
	liteMode: boolean;
	/** Effective intro banner visibility after applying auto-detection. */
	showIntro: boolean;
	/** Effective voice silence threshold after applying learning. */
	voiceSilenceMs: number;
}

/**
 * Compute effective overrides given a resolved Settings object.
 *
 * Rules are deterministic and synchronous - no I/O, no async work.
 * Explicit user-set values ("lite"/"full", "on"/"off") always win over
 * auto-detection.
 */
export function computeAutoTune(settings: Settings): AutoTuneOverrides {
	return {
		liteMode: resolveLiteMode(settings.performance.mode),
		showIntro: resolveIntroBanner(settings.performance.introBanner),
		voiceSilenceMs: settings.voice.silenceThresholdMs,
	};
}

// ─── Internals ──────────────────────────────────────────────────────────────
function resolveLiteMode(mode: "auto" | "lite" | "full"): boolean {
	if (mode === "lite") return true;
	if (mode === "full") return false;

	// mode === "auto" - apply detection rules in priority order.
	// CI environments shouldn't run heartbeat loops or heavy auxiliaries.
	if (process.env.CI === "true") return true;

	// Non-TTY (piped or background) - no TUI, no need for sync work.
	if (!process.stdout.isTTY) return true;

	// Legacy env vars still respected.
	if (process.env["8GENT_LITE"] === "1") return true;
	if (process.env["8GENT_FULL"] === "1") return false;

	// Interactive sessions get the full experience.
	return false;
}

function resolveIntroBanner(introBanner: "auto" | "on" | "off"): boolean {
	if (introBanner === "on") return true;
	if (introBanner === "off") return false;

	// introBanner === "auto" - apply detection rules.
	// No TTY means no banner, ever.
	if (!process.stdout.isTTY) return false;

	// Legacy env var still respected.
	if (process.env["8GENT_NO_INTRO"] === "1") return false;

	// Lite mode skips the banner (established behavior in v0.11.1).
	if (process.env["8GENT_LITE"] === "1") return false;

	return true;
}
