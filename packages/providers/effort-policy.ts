/**
 * Effort policy: pick a thinking level from the kind of task (#3461).
 *
 * Trial, off by default. Only active when EIGHT_EFFORT_POLICY is exactly "1".
 * Any other value (unset, "", "0", "true", " 1") leaves every request exactly
 * as the caller built it.
 *
 * The task kind is the existing `TaskCategory` from packages/ai/task-router.ts.
 * No new classifier: if the caller does not pass a kind, nothing changes.
 *
 * Rules, in order:
 *   1. Flag not exactly "1"           -> request returned unchanged (same object).
 *   2. Caller set `thinking`          -> caller wins, request unchanged.
 *   3. No kind, or a kind not in the table -> provider default, request unchanged.
 *   4. Otherwise fill `thinking` from the table. The router then resolves it
 *      against the provider via resolveThinkingLevel (downgrade or drop).
 *
 * Table rationale: more reasoning mostly buys more checking, so spend it where
 * checking pays (multi-step reasoning), keep it light for quick answers.
 * "creative" has no evidence either way and stays on the provider default.
 */

import type { TaskCategory } from "../ai/task-router";
import type { ThinkingLevel } from "../types/index.js";

export const EFFORT_POLICY_FLAG = "EIGHT_EFFORT_POLICY";

/** Task kind -> requested thinking level. Absent kind = provider default. */
export const EFFORT_BY_TASK_KIND: Readonly<Partial<Record<TaskCategory, ThinkingLevel>>> = {
	simple: "low",
	code: "medium",
	reasoning: "high",
};

/** True only when the flag is exactly "1". */
export function isEffortPolicyEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env[EFFORT_POLICY_FLAG] === "1";
}

/** Requested level for a task kind, or undefined to leave the provider default. */
export function effortForTaskKind(kind: string | undefined): ThinkingLevel | undefined {
	if (!kind || !Object.prototype.hasOwnProperty.call(EFFORT_BY_TASK_KIND, kind)) return undefined;
	return EFFORT_BY_TASK_KIND[kind as TaskCategory];
}

/**
 * Fill `thinking` from `taskKind` when the policy is on and the caller left it
 * empty. Returns the same object when nothing changes, so flag-off behaviour
 * is identical to the code before this file existed.
 */
export function applyEffortPolicy<T extends { thinking?: ThinkingLevel; taskKind?: string }>(
	request: T,
	env: Record<string, string | undefined> = process.env,
): T {
	if (!isEffortPolicyEnabled(env)) return request;
	if (request.thinking) return request;
	const level = effortForTaskKind(request.taskKind);
	if (!level) return request;
	return { ...request, thinking: level };
}
