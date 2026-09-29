/**
 * The plan for the current turn, built only from what the agent writes.
 *
 * Two real sources, nothing else:
 * 1. The plan text: a `PLAN:` block with numbered or bulleted lines
 *    (planStepsFromText). It gives step text only. Steps from text start
 *    as "pending"; text alone never marks anything done.
 * 2. The agent's update_plan tool calls: the full step list, each with a
 *    status. This is the only thing that may tick a step, fail it, or mark
 *    the current one.
 *
 * There is deliberately no heuristic that matches tool calls to steps. If
 * the agent never reports progress, steps stay "pending" and the summary
 * says "0 of 5 done", which is the truth.
 */

export type PlanStepStatus = "pending" | "active" | "done" | "failed";

export interface PlanStep {
	id: string;
	text: string;
	status: PlanStepStatus;
}

const STATUS_ALIASES: Record<string, PlanStepStatus> = {
	pending: "pending",
	todo: "pending",
	in_progress: "active",
	"in-progress": "active",
	active: "active",
	doing: "active",
	completed: "done",
	complete: "done",
	done: "done",
	failed: "failed",
	fail: "failed",
	error: "failed",
	blocked: "failed",
};

export function normaliseStatus(value: unknown): PlanStepStatus {
	if (typeof value !== "string") return "pending";
	return STATUS_ALIASES[value.trim().toLowerCase()] ?? "pending";
}

function keyOf(text: string): string {
	return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Merge freshly written step text into the plan. Steps already present
 * (same text) keep their status and position; new steps are appended, so a
 * step added mid-run lands at the end instead of reshuffling the list.
 */
export function mergePlanText(prev: ReadonlyArray<PlanStep>, texts: ReadonlyArray<string>): PlanStep[] {
	const seen = new Set(prev.map((s) => keyOf(s.text)));
	const next = [...prev];
	for (const text of texts) {
		const k = keyOf(text);
		if (!k || seen.has(k)) continue;
		seen.add(k);
		next.push({ id: `step-${next.length + 1}-${k.slice(0, 24)}`, text: text.trim(), status: "pending" });
	}
	return next;
}

export interface PlanUpdateItem {
	step?: unknown;
	text?: unknown;
	content?: unknown;
	status?: unknown;
}

/**
 * Apply an update_plan call. The call carries the whole list, so it is the
 * authority on order and status. Steps are matched by text to keep ids
 * stable (and so rows do not re-land); unknown text becomes a new step.
 * At most one step is active: if several say so, the first wins.
 */
export function applyPlanUpdate(prev: ReadonlyArray<PlanStep>, items: ReadonlyArray<PlanUpdateItem>): PlanStep[] {
	const byKey = new Map(prev.map((s) => [keyOf(s.text), s]));
	const out: PlanStep[] = [];
	let activeSeen = false;
	for (const item of items) {
		const raw = item.step ?? item.text ?? item.content;
		if (typeof raw !== "string" || !raw.trim()) continue;
		let status = normaliseStatus(item.status);
		if (status === "active") {
			if (activeSeen) status = "pending";
			activeSeen = true;
		}
		const existing = byKey.get(keyOf(raw));
		out.push({
			id: existing?.id ?? `step-${prev.length + out.length + 1}-${keyOf(raw).slice(0, 24)}`,
			text: raw.trim(),
			status,
		});
	}
	return out;
}

/** When the turn ends, nothing is still in progress: an active step that
 *  was never reported done goes back to pending, it is not ticked. */
export function settlePlan(steps: ReadonlyArray<PlanStep>): PlanStep[] {
	return steps.map((s) => (s.status === "active" ? { ...s, status: "pending" } : s));
}
