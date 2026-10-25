/**
 * Thinking level to request fields (#5040).
 *
 * One pure place that says which field, if any, carries a thinking level on a
 * given provider's wire. It sends only fields the existing clients already
 * speak, and says "not applicable" for every provider with no such control, so
 * a level is never sent where it would be ignored or rejected.
 *
 * Levels: "off" leaves the provider's own default untouched (nothing is sent).
 * "low" is the fast setting: on a local model it turns thinking off, on a
 * hosted reasoning API it asks for the lowest effort. "medium" and "high" ask
 * for more. "max" is the highest real control a provider has: every wire below tops
 * out at the "high" setting (Anthropic its largest budget, Ollama think true), so
 * max is sent as high, and the status line says so (thinkingStatusLabel).
 *
 * Wire shapes:
 *   ollama-native  /api/chat                 think: boolean (gpt-oss: "low" | "medium" | "high")
 *   ollama-openai  /v1/chat/completions      reasoning_effort: "none" | "low" | "medium" | "high"
 *   openrouter     openrouter.ai             reasoning: { effort }
 *   openai         OpenAI-compatible APIs    reasoning_effort
 *   anthropic      Messages API              thinking: { type: "enabled", budget_tokens }
 */

import type { ThinkingLevel } from "../types/index.js";

/** What the 8gent asks for each turn. "off" sends nothing. */
export type ThinkingSetting = "off" | "low" | "medium" | "high" | "max";

export const THINKING_SETTINGS: readonly ThinkingSetting[] = [
	"off",
	"low",
	"medium",
	"high",
	"max",
];

export type ThinkingWire =
	| "ollama-native"
	| "ollama-openai"
	| "openrouter"
	| "openai"
	| "anthropic";

/** Anthropic extended-thinking budget in output tokens, by level. */
export const ANTHROPIC_THINKING_BUDGET: Record<ThinkingLevel, number> = {
	minimal: 1024,
	low: 4096,
	medium: 12288,
	high: 32768,
};

export interface ThinkingTarget {
	provider: string;
	model: string;
	/** Which request shape the caller is about to build. */
	shape: "native" | "openai";
	/** The endpoint, used to tell OpenRouter from other OpenAI-compatible hosts. */
	baseUrl?: string;
}

export interface ThinkingFields {
	/** True when a thinking field was added to the request. */
	applied: boolean;
	/** Fields to merge into the request body. Empty when not applied. */
	fields: Record<string, unknown>;
	/** Why nothing was sent, when it was not. */
	reason?: "off" | "not-applicable";
}

const NONE: ThinkingFields = { applied: false, fields: {}, reason: "not-applicable" };

function hostOf(url: string | undefined): string {
	if (!url) return "";
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/** The wire this target speaks for thinking, or null when it has no control. */
export function thinkingWireFor(target: ThinkingTarget): ThinkingWire | null {
	const provider = target.provider;
	if (provider === "ollama" || provider === "8gent") {
		return target.shape === "native" ? "ollama-native" : "ollama-openai";
	}
	if (provider === "openrouter" || hostOf(target.baseUrl) === "openrouter.ai") return "openrouter";
	if (provider === "openai") return "openai";
	if (provider === "anthropic") return target.shape === "native" ? "anthropic" : null;
	return null;
}

/** gpt-oss on Ollama cannot turn thinking off; it takes a level instead. */
function isGptOss(model: string): boolean {
	return /^gpt-oss/i.test(model);
}

/** The request fields for a thinking level on a target. Pure. */
export function thinkingRequestFields(
	target: ThinkingTarget,
	requested: ThinkingLevel | ThinkingSetting,
): ThinkingFields {
	const level = requested === "max" ? "high" : requested;
	if (level === "off") return { applied: false, fields: {}, reason: "off" };
	const wire = thinkingWireFor(target);
	if (wire === null) return NONE;
	const fast = level === "low" || level === "minimal";
	switch (wire) {
		case "ollama-native":
			return {
				applied: true,
				fields: { think: isGptOss(target.model) ? (fast ? "low" : level) : !fast },
			};
		case "ollama-openai":
			return {
				applied: true,
				fields: {
					reasoning_effort: fast ? (isGptOss(target.model) ? "low" : "none") : level,
				},
			};
		case "openrouter":
			return { applied: true, fields: { reasoning: { effort: level } } };
		case "openai":
			return { applied: true, fields: { reasoning_effort: level } };
		case "anthropic":
			return {
				applied: true,
				fields: {
					thinking: { type: "enabled", budget_tokens: ANTHROPIC_THINKING_BUDGET[level] },
				},
			};
	}
}

/**
 * True when a provider's refusal says the model has no thinking control, so the
 * caller can drop the field and send the request again.
 */
export function isThinkingUnsupported(status: number, body: string): boolean {
	return status === 400 && /think|reasoning/i.test(body);
}
