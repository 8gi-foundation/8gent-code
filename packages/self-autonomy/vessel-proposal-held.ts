/**
 * Decide from check results when a local change has held on this device, and
 * which named checks it fixed. Pure: no database, no I/O (issue #4937).
 *
 * A check missing from a run is treated as not passing.
 */

export type CheckResult = "pass" | "fail";
export type CheckMap = Record<string, CheckResult>;
export interface CheckRun {
	runId: string;
	checks: CheckMap;
}

const passes = (m: CheckMap, name: string): boolean =>
	Object.prototype.hasOwnProperty.call(m, name) && m[name] === "pass";

/** Sorted names of checks that went fail to pass. A check absent before counts as not passing. */
export function fixedChecks(before: CheckMap, after: CheckMap): string[] {
	return Object.keys(after)
		.filter((n) => after[n] === "pass" && !passes(before, n))
		.sort();
}

/** Sorted names of checks that went pass to fail. A check absent after counts as not passing. */
export function regressedChecks(before: CheckMap, after: CheckMap): string[] {
	return Object.keys(before)
		.filter((n) => before[n] === "pass" && !passes(after, n))
		.sort();
}

/**
 * True only when the last `runs` entries exist and no check that passed in the
 * baseline run (the oldest entry of that window) regressed in any later one.
 * `runs` is required; this slice chooses no default.
 */
export function heldForRuns(history: CheckRun[], runs: number): boolean {
	if (!Number.isInteger(runs) || runs < 1 || history.length < runs) return false;
	const window = history.slice(history.length - runs);
	const baseline = window[0].checks;
	return window.slice(1).every((r) => regressedChecks(baseline, r.checks).length === 0);
}
