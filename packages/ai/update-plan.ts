/**
 * update_plan (#3035): the agent reports the status of its own plan steps.
 *
 * The tool executes nothing. The plan event IS the tool call: both tool paths
 * fire onToolStart with the call's args, and the TUI PLAN column
 * (apps/tui/src/lib/plan-state.ts applyPlanUpdate) reads `plan` from there.
 * This module only validates the list and returns a short acknowledgement, so
 * the model gets a result and a malformed call gets a clear error.
 *
 * update_plan is not an action tool (packages/eight/honesty.ts ACTION_TOOLS):
 * marking a step "done" can never ground a completion claim on its own.
 */

export const PLAN_STATUSES = ["pending", "in_progress", "done", "failed"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

// The first sentence is all the text-tool catalog shows (DESC_CAP 140 in
// packages/ai/text-tools.ts) and it does not render nested schemas, so the
// argument shape has to live in that sentence.
export const UPDATE_PLAN_DESCRIPTION =
	"Report plan progress: plan is every step as {step, status}, status pending, in_progress, done or failed; send it with other calls. It changes nothing on disk.";

// The text-tool path is not schema-validated, so accept the spellings models
// commonly use for the same four states.
const ALIASES: Record<string, PlanStatus> = {
	pending: "pending",
	todo: "pending",
	in_progress: "in_progress",
	"in-progress": "in_progress",
	active: "in_progress",
	done: "done",
	completed: "done",
	complete: "done",
	failed: "failed",
};

export interface PlanItem {
	step: string;
	status: PlanStatus;
}

export function parsePlan(
	plan: unknown,
): { ok: true; items: PlanItem[] } | { ok: false; error: string } {
	if (!Array.isArray(plan) || plan.length === 0) {
		return { ok: false, error: "plan must be a non-empty array of {step, status}" };
	}
	const items: PlanItem[] = [];
	for (const [i, raw] of plan.entries()) {
		const item = raw as { step?: unknown; status?: unknown } | null;
		const step = typeof item?.step === "string" ? item.step.trim() : "";
		if (!step) return { ok: false, error: `plan[${i}].step must be a non-empty string` };
		const status =
			typeof item?.status === "string" ? ALIASES[item.status.trim().toLowerCase()] : undefined;
		if (!status) {
			return { ok: false, error: `plan[${i}].status must be one of ${PLAN_STATUSES.join(", ")}` };
		}
		items.push({ step, status });
	}
	return { ok: true, items };
}

/** The tool result: an acknowledgement, or an "Error:" string both paths classify as a failed call. */
export function updatePlan(args: { plan?: unknown } | undefined): string {
	const parsed = parsePlan(args?.plan);
	if (!parsed.ok) return `Error: update_plan: ${parsed.error}`;
	const { items } = parsed;
	const done = items.filter((s) => s.status === "done").length;
	const failed = items.filter((s) => s.status === "failed").length;
	const current = items.find((s) => s.status === "in_progress");
	return [
		`Plan updated: ${done} of ${items.length} done`,
		failed ? `, ${failed} failed` : "",
		current ? `. Current: ${current.step}` : "",
	].join("");
}
