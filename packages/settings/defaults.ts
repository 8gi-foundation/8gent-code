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
	},
};
