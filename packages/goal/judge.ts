/**
 * Judge interface + verdict validation.
 *
 * The judge is a different model from the executor. Same-model judging
 * collapses to self-grading and defeats the point of the loop, so we
 * reject identical model ids at construction.
 *
 * This file is the spec only. Wiring to a concrete provider (Apple
 * Foundation, OpenRouter `:free`, etc.) happens in the daemon glue
 * layer using `packages/providers/failover.ts`. Keeping inference out of
 * `packages/goal/` is what lets the loop be tested with mock judges.
 */

import { type JudgeHandle, type JudgeVerdict, SATISFIED_CONFIDENCE_FLOOR } from "./types";

export class JudgeExecutorCollisionError extends Error {
	constructor(model: string) {
		super(
			`judge model and executor model are both "${model}" - /go requires a different judge model (8TO mitigation: self-judging defeats the loop)`,
		);
		this.name = "JudgeExecutorCollisionError";
	}
}

export class InvalidVerdictError extends Error {
	constructor(reason: string) {
		super(`invalid judge verdict: ${reason}`);
		this.name = "InvalidVerdictError";
	}
}

/**
 * Assert the judge handle is wired to a different model than the executor.
 * Caller in `goal-loop.ts` runs this once at construction.
 */
export function assertDistinctJudge(executorModel: string, judgeModel: string): void {
	if (!executorModel || !judgeModel) {
		throw new InvalidVerdictError("executor and judge must both have non-empty model ids");
	}
	if (normalize(executorModel) === normalize(judgeModel)) {
		throw new JudgeExecutorCollisionError(executorModel);
	}
}

function normalize(model: string): string {
	return model.trim().toLowerCase();
}

/**
 * Structural validation of a verdict before the loop trusts it. Rejects
 * malformed shapes, out-of-range confidence, and unknown decisions.
 */
export function validateVerdict(raw: unknown): JudgeVerdict {
	if (!raw || typeof raw !== "object") {
		throw new InvalidVerdictError("verdict must be a JSON object");
	}
	const r = raw as Record<string, unknown>;
	const decision = r.decision;
	if (decision !== "satisfied" && decision !== "continue" && decision !== "failed") {
		throw new InvalidVerdictError(`decision must be satisfied|continue|failed, got ${String(decision)}`);
	}
	const confidence = typeof r.confidence === "number" ? r.confidence : NaN;
	if (!(confidence >= 0 && confidence <= 1)) {
		throw new InvalidVerdictError(`confidence must be in [0,1], got ${String(r.confidence)}`);
	}
	const summary = typeof r.summary === "string" ? r.summary.trim() : "";
	if (!summary) {
		throw new InvalidVerdictError("summary must be a non-empty string");
	}
	if (/[—]/.test(summary)) {
		// Prohibition: no em dashes in user-visible copy.
		throw new InvalidVerdictError("summary contains em dash - banned by brand rules");
	}
	const verdict: JudgeVerdict = {
		decision,
		confidence,
		summary,
	};
	if (r.criteria !== undefined) {
		if (!Array.isArray(r.criteria)) {
			throw new InvalidVerdictError("criteria must be an array");
		}
		verdict.criteria = r.criteria.map((c, i) => {
			if (!c || typeof c !== "object") {
				throw new InvalidVerdictError(`criteria[${i}] must be an object`);
			}
			const cr = c as Record<string, unknown>;
			if (typeof cr.name !== "string" || typeof cr.passed !== "boolean") {
				throw new InvalidVerdictError(`criteria[${i}] needs string name + boolean passed`);
			}
			return {
				name: cr.name,
				passed: cr.passed,
				weight: typeof cr.weight === "number" ? cr.weight : undefined,
			};
		});
	}
	if (typeof r.nextStep === "string") verdict.nextStep = r.nextStep;
	if (typeof r.notes === "string") verdict.notes = r.notes;
	return verdict;
}

/**
 * Apply the confidence floor. A `satisfied` verdict below the floor is
 * demoted to `continue` so the loop keeps working rather than declaring
 * victory on weak evidence.
 */
export function applyConfidenceFloor(verdict: JudgeVerdict): JudgeVerdict {
	if (verdict.decision === "satisfied" && verdict.confidence < SATISFIED_CONFIDENCE_FLOOR) {
		return {
			...verdict,
			decision: "continue",
			notes:
				(verdict.notes ? `${verdict.notes}\n` : "") +
				`(demoted from satisfied: confidence ${verdict.confidence.toFixed(2)} below floor ${SATISFIED_CONFIDENCE_FLOOR})`,
		};
	}
	return verdict;
}

/**
 * Adapter helper for callers that want to wrap an LLM call into a
 * JudgeHandle. The actual provider call is supplied as `complete`; this
 * function adds the validation + floor logic.
 */
export function makeJudgeHandle(opts: {
	model: string;
	complete: (input: import("./types").JudgeHandleInput) => Promise<unknown>;
}): JudgeHandle {
	return {
		model: opts.model,
		async score(input) {
			const raw = await opts.complete(input);
			const verdict = validateVerdict(raw);
			return applyConfidenceFloor(verdict);
		},
	};
}
