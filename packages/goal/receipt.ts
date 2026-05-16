/**
 * Receipt assembly. Pure function from terminal `GoalRun` to `Receipt`.
 *
 * No copy decisions here - 8DO owns the user-facing verdict text. This
 * file produces the structured record that copy is rendered from.
 */

import { isTerminal } from "./state-machine";
import type { GoalRun, Receipt } from "./types";

export function buildReceipt(run: GoalRun): Receipt {
	if (!isTerminal(run.status)) {
		throw new Error(`cannot build receipt for non-terminal run (status=${run.status})`);
	}
	if (run.stopReason === null) {
		throw new Error("terminal run must have a stopReason");
	}
	const endedAt = run.endedAt ?? Date.now();
	return {
		runId: run.id,
		sessionId: run.sessionId,
		goal: run.goal,
		status: run.status as Receipt["status"],
		stopReason: run.stopReason,
		finalVerdict: run.finalVerdict,
		turns: run.history.map((h) => ({
			turn: h.turn,
			executor: h.executor,
			verdict: h.verdict,
		})),
		counters: { ...run.counters },
		startedAt: run.startedAt,
		endedAt,
		durationMs: endedAt - run.startedAt,
		executorModel: run.executorModel,
		judgeModel: run.judgeModel,
		totalTokens: run.counters.tokens,
	};
}
