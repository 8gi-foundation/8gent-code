/**
 * 8gent AI - Per-model harness profile (#4439)
 *
 * The harness knobs that decide a long run (step budget, when the turn-budget
 * nudge fires, output token cap) were one fixed set for every model. Measured
 * runs show the same task passing on one model and timing out on another, so a
 * small table keyed by model id (harness-profiles.json) can move them, inside
 * hard bounds. A model with no entry keeps today's values exactly.
 *
 * Every entry carries a `why` naming the runs that justify it. Nothing here
 * touches permissions, policy checks or judges.
 */

import table from "./harness-profiles.json";
import { NUDGE_FRACTION } from "./turn-budget";

export interface HarnessProfileEntry {
	maxSteps?: number;
	nudgeFraction?: number;
	maxOutputTokens?: number;
	/**
	 * Reasoning token cap sent to OpenRouter as `reasoning.max_tokens` (#4454).
	 * Clamped by applyReasoningCap so text and tool calls keep room.
	 */
	reasoningMaxTokens?: number;
	/**
	 * Reasoning effort sent to OpenRouter as `reasoning.effort` (#4454). Wins
	 * over reasoningMaxTokens: OpenRouter takes one or the other.
	 */
	reasoningEffort?: "low" | "medium" | "high";
	/** The measured runs that justify this entry. */
	why: string;
}

export type HarnessProfileTable = Record<string, HarnessProfileEntry>;

export interface HarnessProfile {
	/** The table key used, or "default" when the model has no entry. */
	source: string;
	maxSteps: number;
	nudgeFraction: number;
	maxOutputTokens: number;
}

export const HARNESS_BOUNDS = {
	maxSteps: [20, 80],
	nudgeFraction: [0.5, 0.9],
	maxOutputTokens: [1024, 32768],
} as const;

// JSON types reasoningEffort as string; applyReasoningCap checks the value at runtime.
export const HARNESS_PROFILES: HarnessProfileTable = table as HarnessProfileTable;

function bounded(value: unknown, [lo, hi]: readonly [number, number], fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(hi, Math.max(lo, value));
}

/**
 * The knobs for `model`. `defaults` are today's values at the call site
 * (maxSteps 30, maxOutputTokens 4096 local / 8192 cloud); the nudge default is
 * turn-budget's NUDGE_FRACTION. Values from an entry are clamped to HARNESS_BOUNDS.
 */
export function resolveHarnessProfile(
	model: string | undefined,
	defaults: { maxSteps: number; maxOutputTokens: number },
	profiles: HarnessProfileTable = HARNESS_PROFILES,
): HarnessProfile {
	const entry = model ? profiles[model] : undefined;
	if (!entry || !model) {
		return { source: "default", ...defaults, nudgeFraction: NUDGE_FRACTION };
	}
	return {
		source: model,
		maxSteps: Math.round(bounded(entry.maxSteps, HARNESS_BOUNDS.maxSteps, defaults.maxSteps)),
		nudgeFraction: bounded(entry.nudgeFraction, HARNESS_BOUNDS.nudgeFraction, NUDGE_FRACTION),
		maxOutputTokens: Math.round(
			bounded(entry.maxOutputTokens, HARNESS_BOUNDS.maxOutputTokens, defaults.maxOutputTokens),
		),
	};
}

/** The one line a session logs, so a run can be explained by the profile it ran under. */
export function harnessProfileLine(model: string | undefined, p: HarnessProfile): string {
	return `[harness-profile] model=${model ?? "unknown"} profile=${p.source} maxSteps=${p.maxSteps} nudge=${p.nudgeFraction} maxOutputTokens=${p.maxOutputTokens}`;
}

/** Output tokens a step always keeps for text and tool calls under a reasoning cap. */
export const REASONING_TEXT_RESERVE = 2048;

/**
 * Add `reasoning: { effort }` or `reasoning: { max_tokens }` to an OpenRouter
 * chat request body when the model's entry sets reasoningEffort or
 * reasoningMaxTokens (#4454); effort wins. A reasoning model that spends
 * its whole output budget thinking returns no text and no tool call (finish
 * length); capping the thinking below max_tokens leaves room to act. The cap
 * is clamped to max_tokens - REASONING_TEXT_RESERVE and dropped when no room
 * is left. Any other provider, model or entry: the body comes back unchanged.
 */
export function applyReasoningCap<B extends Record<string, unknown>>(
	provider: string,
	model: string,
	body: B,
	profiles: HarnessProfileTable = HARNESS_PROFILES,
): B & { reasoning?: { max_tokens: number } | { effort: string } } {
	if (provider !== "openrouter") return body;
	const effort = profiles[model]?.reasoningEffort;
	if (effort === "low" || effort === "medium" || effort === "high") {
		return { ...body, reasoning: { effort } };
	}
	const want = profiles[model]?.reasoningMaxTokens;
	if (typeof want !== "number" || !Number.isFinite(want) || want < 1) {
		return body;
	}
	const maxTokens =
		typeof body.max_tokens === "number" ? body.max_tokens : Number.POSITIVE_INFINITY;
	const cap = Math.floor(Math.min(want, maxTokens - REASONING_TEXT_RESERVE));
	if (cap < 1) return body;
	return { ...body, reasoning: { max_tokens: cap } };
}
