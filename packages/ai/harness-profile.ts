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

export const HARNESS_PROFILES: HarnessProfileTable = table;

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
