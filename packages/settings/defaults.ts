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
		ttsVoice: "Ava",
		// TTS plays agent responses out of the box. Toggle with `/voice off`.
		outputEnabled: true,
		// Each tab role speaks in its own macOS voice so multi-agent flows are
		// audibly distinct. Defaults pick standard high-quality voices that
		// ship on macOS:
		//   - Daniel  (en-GB) — measured, fits an orchestrator
		//   - Karen   (en-AU) — clear and technical, fits an engineer
		//   - Moira   (en-IE) — auditor cadence, fits QA
		// Fallback to `voice.ttsVoice` if a role is missing.
		perAgent: {
			orchestrator: "Daniel",
			engineer: "Karen",
			qa: "Moira",
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
		// 11435 is where the apfel bridge actually listens. Two wrong ports have
		// shipped here before and each failed in its own misleading way:
		//
		//   11500 - nothing listens. Connection refused, so apfel looked "down"
		//           when the bridge was up the whole time.
		//   11434 - OLLAMA's port. Far worse, because it does NOT refuse: Ollama
		//           answers the request and fails on an unknown model, so apfel
		//           appeared broken while a different engine was silently serving
		//           it. See packages/providers/__tests__/keyless-local.test.ts.
		//
		// packages/providers/index.ts is the source of truth for this URL and is
		// test-pinned to 11435. Keep this value equal to it or delete this entry.
		apfel: { baseURL: "http://127.0.0.1:11435/v1" },
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
	music: {
		// Audible, well short of loud: a first-ever track never starts at 100% (#3190).
		volume: 60,
	},
};
