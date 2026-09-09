/**
 * 8gent Code - Default Settings
 *
 * Canonical defaults that mirror the existing hardcoded values across the
 * codebase. Changes here ship as the new out-of-box experience.
 */

import type { Settings } from "./schema.js";

export const DEFAULT_SETTINGS: Settings = {
	version: 1,
	voice: {
		silenceThresholdMs: 2000,
		bargeIn: true,
		// KittenTTS is the default engine: a local neural voice instead of the
		// macOS `say` robot. Falls back to `say` when the Python package is
		// missing. Per-engine voice names and defaults live in ./voice.ts.
		engine: "kitten",
		// The default voice is the deepest male voice the engine has: Bruno,
		// measured at about 108 Hz mean pitch against Jasper 137, Hugo 159 and
		// Leo 166. It is what the intro and every reply use until the user
		// picks another in onboarding or with `/voice pick`.
		ttsVoice: "Bruno",
		// TTS plays agent responses out of the box. Toggle with `/voice off`.
		outputEnabled: true,
		// Each tab role speaks in its own voice so multi-agent flows are
		// audibly distinct. These are KittenTTS voices (see ENGINE_VOICES):
		//   - Bruno   warm and authoritative, the deep default, orchestrator
		//   - Jasper  crisp and technical, engineer
		//   - Hugo    neutral and steady, QA
		// Tabs beyond these three roles get their own voice from the rotation
		// in ./voice.ts, so no two agents on screen sound the same.
		// Fallback to `voice.ttsVoice` if a role is missing or the name is not
		// a voice of the active engine.
		perAgent: {
			orchestrator: "Bruno",
			engineer: "Jasper",
			qa: "Hugo",
		},
	},
	performance: {
		mode: "auto",
		introBanner: "auto",
	},
	models: {
		tabs: {
			orchestrator: { provider: "ollama", model: "qwen3.6:27b" },
			engineer: { provider: "lmstudio", model: "google/gemma-4-26b-a4b" },
			qa: { provider: "apfel", model: "apple-foundationmodel" },
		},
	},
	providers: {
		apfel: { baseURL: "http://localhost:11500/v1" },
		ollama: { baseURL: "http://localhost:11434/v1" },
		lmstudio: { baseURL: "http://localhost:1234/v1" },
		openrouter: { baseURL: "https://openrouter.ai/api/v1" },
	},
	ui: {
		theme: "amber",
		thinkingVisualiser: {
			enabled: true,
			operatorRotationMs: 8000,
			boredomThresholdMs: 30000,
		},
		// Empty default = silent. Drop a sound file (e.g. ~/.8gent/sounds/intro.mp3)
		// and set this path via /settings or by editing ~/.8gent/settings.json
		// to play a heavenly swell on TUI launch. macOS afplay handles it.
		introSound: "",
	},
	agents: {
		// Default names match the canonical role-registry roles. Users can
		// rename these during onboarding (steps 9-11) or via /settings later.
		// The names show up in:
		//   - TabBar tab titles (apps/tui/src/hooks/useWorkspaceTabs.ts)
		//   - Agent system prompts (packages/orchestration/role-registry.ts via
		//     resolveRoleName())
		//   - Status bar role indicator
		// Renaming is purely a display-layer change — the role itself stays the
		// canonical "orchestrator" / "engineer" / "qa" key everywhere internally.
		names: {
			orchestrator: "Orchestrator",
			engineer: "Engineer",
			qa: "QA",
		},
	},
};
