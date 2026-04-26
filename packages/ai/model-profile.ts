/**
 * 8gent AI - Model Profiles
 *
 * Describes model capabilities, costs, and speed so the task router
 * (and humans) can pick the right model for each job.
 */

import type { ProviderConfig } from "./providers.js";

// ── types ────────────────────────────────────────────────────────────

export type StrengthArea =
	| "code-generation"
	| "code-review"
	| "debugging"
	| "conversation"
	| "empathy"
	| "creative-writing"
	| "reasoning"
	| "math"
	| "analysis"
	| "summarization"
	| "extraction"
	| "translation"
	| "tool-use"
	| "instruction-following";

export type CostTier = "free" | "low" | "medium" | "high" | "premium";
export type SpeedTier = "instant" | "fast" | "moderate" | "slow";

export interface ModelProfile {
	modelPattern: string;
	displayName: string;
	strengths: StrengthArea[];
	weaknesses: StrengthArea[];
	contextWindow: number;
	costTier: CostTier;
	speedTier: SpeedTier;
	provider: string;
	notes?: string;
}

// ── registry ─────────────────────────────────────────────────────────

export const MODEL_PROFILES: Record<string, ModelProfile> = {
	"qwen3:32b": {
		modelPattern: "qwen3:32b",
		displayName: "Qwen 3 32B",
		strengths: ["reasoning", "math", "code-generation"],
		weaknesses: ["creative-writing", "empathy"],
		contextWindow: 32_768,
		costTier: "free",
		speedTier: "moderate",
		provider: "ollama",
		notes: "Local via Ollama. Strong on structured tasks.",
	},

	"llama-3.3-70b-versatile": {
		modelPattern: "llama-3.3*",
		displayName: "Llama 3.3 70B Versatile",
		strengths: ["instruction-following", "conversation", "reasoning"],
		weaknesses: ["math"],
		contextWindow: 128_000,
		costTier: "free",
		speedTier: "fast",
		provider: "groq",
		notes: "Groq free tier. Excellent latency for its size.",
	},

	"gemma-4-26b-a4b": {
		modelPattern: "gemma-4-26b*",
		displayName: "Gemma 4 26B A4B",
		strengths: ["code-generation", "reasoning", "analysis"],
		weaknesses: ["conversation", "empathy"],
		contextWindow: 32_768,
		costTier: "free",
		speedTier: "moderate",
		provider: "lmstudio",
		notes: "Local via LM Studio. Good code model, weak on chat.",
	},

	"mistral-small": {
		modelPattern: "mistral-small*",
		displayName: "Mistral Small",
		strengths: ["summarization", "extraction", "instruction-following"],
		weaknesses: ["code-generation", "math"],
		contextWindow: 32_768,
		costTier: "low",
		speedTier: "fast",
		provider: "openrouter",
		notes: "Cheap and fast for text processing tasks.",
	},
};

// ── functions ────────────────────────────────────────────────────────

/**
 * Convert a simple glob pattern (only `*` wildcards) to a RegExp.
 * `*` matches zero or more of any character.
 */
function globToRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const regexStr = escaped.replace(/\*/g, ".*");
	return new RegExp(`^${regexStr}$`);
}

/**
 * Look up a ModelProfile for a given ProviderConfig.
 * Matches `config.model` against each profile's `modelPattern`.
 */
export function getProfile(config: ProviderConfig): ModelProfile | undefined {
	// Exact key match first (fast path)
	if (MODEL_PROFILES[config.model]) {
		return MODEL_PROFILES[config.model];
	}

	// Glob match against all patterns
	for (const profile of Object.values(MODEL_PROFILES)) {
		const regex = globToRegex(profile.modelPattern);
		if (regex.test(config.model)) {
			return profile;
		}
	}

	return undefined;
}

/**
 * Score how well a model fits a task's required strengths.
 *
 * Returns a value in [-1, 1]:
 *   +0.2 per required strength found in profile.strengths
 *   -0.2 per required strength found in profile.weaknesses
 *    0   for items in neither list
 */
export function scoreModelForTask(
	profile: ModelProfile,
	requiredStrengths: StrengthArea[],
): number {
	let raw = 0;

	for (const area of requiredStrengths) {
		if (profile.strengths.includes(area)) {
			raw += 0.2;
		} else if (profile.weaknesses.includes(area)) {
			raw -= 0.2;
		}
	}

	return Math.max(-1, Math.min(1, raw));
}
