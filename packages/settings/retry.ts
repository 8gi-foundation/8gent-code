/**
 * Retry and timeout settings (matrix row C4).
 *
 * Pi reads retry.* from its settings manager. Here the three knobs live in
 * settings.retry; `null` (or any value that fails validation) means "the
 * built-in default", so a bad value in a hand-edited or project file can never
 * stall the agent or turn retries into a flood.
 */

import { DEFAULT_SETTINGS } from "./defaults.js";
import type { RetrySettings, Settings } from "./schema.js";

export const RETRY_LIMITS = {
	maxRetries: { min: 0, max: 20 },
	maxDelayMs: { min: 1_000, max: 600_000 },
	httpIdleTimeoutMs: { min: 1_000, max: 86_400_000 },
} as const;

export interface ResolvedRetrySettings {
	/** undefined = keep the built-in (AI SDK default; 8 for ":free" models in getRetryConfig). */
	maxRetries: number | undefined;
	maxDelayMs: number;
	/** undefined = keep the built-in idle gap. */
	httpIdleTimeoutMs: number | undefined;
}

function wholeInRange(v: unknown, min: number, max: number): number | undefined {
	return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

/** Validate a retry block. Anything out of range or of the wrong type becomes the default. */
export function resolveRetrySettings(retry?: Partial<RetrySettings> | null): ResolvedRetrySettings {
	const r = retry ?? {};
	const L = RETRY_LIMITS;
	return {
		maxRetries: wholeInRange(r.maxRetries, L.maxRetries.min, L.maxRetries.max),
		maxDelayMs:
			wholeInRange(r.maxDelayMs, L.maxDelayMs.min, L.maxDelayMs.max) ?? DEFAULT_SETTINGS.retry.maxDelayMs,
		httpIdleTimeoutMs: wholeInRange(r.httpIdleTimeoutMs, L.httpIdleTimeoutMs.min, L.httpIdleTimeoutMs.max),
	};
}

/** Convenience: resolve from a whole settings object. */
export function resolveRetryFrom(settings: Settings): ResolvedRetrySettings {
	return resolveRetrySettings(settings.retry);
}
