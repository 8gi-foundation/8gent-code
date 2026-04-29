/**
 * Thinking-level (reasoning-budget) resolution.
 *
 * Providers advertise a `supportedThinkingLevels` array. The router calls
 * `resolveThinkingLevel()` with the requested level and the provider's
 * supported set. If the requested level is unsupported, the resolver walks
 * down the canonical ordering (high -> medium -> low -> minimal) and returns
 * the highest supported level at or below the request. If the provider
 * supports no thinking at all, it returns `null` and the router treats the
 * call as non-thinking.
 *
 * This file does not call any APIs. It is pure logic so it stays trivially
 * unit-testable and reusable by orchestration code that wants to forecast
 * cost without dispatching a request.
 */

import { THINKING_LEVELS_ORDERED, type ThinkingLevel } from "../types/index.js";

export { THINKING_LEVELS_ORDERED, type ThinkingLevel };

/**
 * Resolve a requested thinking level against a provider's supported set.
 *
 * Returns the requested level when supported, otherwise the highest supported
 * level strictly below the request (downgrade), otherwise `null` when the
 * provider supports no thinking at all.
 *
 * Examples:
 *   resolveThinkingLevel("high",   ["minimal","low","medium","high"]) -> "high"
 *   resolveThinkingLevel("high",   ["minimal","low"])                 -> "low"
 *   resolveThinkingLevel("medium", ["minimal"])                       -> "minimal"
 *   resolveThinkingLevel("high",   [])                                -> null
 */
export function resolveThinkingLevel(
	requested: ThinkingLevel,
	supported: readonly ThinkingLevel[],
): ThinkingLevel | null {
	if (supported.length === 0) return null;
	const requestedIdx = THINKING_LEVELS_ORDERED.indexOf(requested);
	if (requestedIdx === -1) return null;

	const supportedSet = new Set(supported);
	for (let i = requestedIdx; i >= 0; i--) {
		const level = THINKING_LEVELS_ORDERED[i];
		if (level !== undefined && supportedSet.has(level)) return level;
	}
	return null;
}

/**
 * Multiplier applied to baseline token-usage estimates when thinking is
 * enabled. Used by budget tracking before a call dispatches. These numbers
 * are deliberately rough; provider-specific tuning is a follow-up.
 */
export function thinkingTokenMultiplier(level: ThinkingLevel | null | undefined): number {
	switch (level) {
		case "high":
			return 4.0;
		case "medium":
			return 2.0;
		case "low":
			return 1.25;
		case "minimal":
			return 1.05;
		default:
			return 1.0;
	}
}

/**
 * Outcome of resolving a thinking level for a routing decision. Surfaces
 * whether a downgrade happened so callers can log or warn. `level` is
 * `null` when the provider supports no thinking at all.
 */
export interface ThinkingResolution {
	requested: ThinkingLevel;
	level: ThinkingLevel | null;
	downgraded: boolean;
	tokenMultiplier: number;
}

/**
 * Convenience wrapper that returns a structured resolution rather than just
 * the resolved level. Routers use this so orchestration can read both the
 * resolved level and whether the request was downgraded in a single hop.
 */
export function resolveThinkingForRouting(
	requested: ThinkingLevel,
	supported: readonly ThinkingLevel[],
): ThinkingResolution {
	const level = resolveThinkingLevel(requested, supported);
	return {
		requested,
		level,
		downgraded: level !== null && level !== requested,
		tokenMultiplier: thinkingTokenMultiplier(level),
	};
}
