/**
 * @8gent/goal - Goal-loop orchestrator for the /go feature.
 *
 * Public surface. Everything here is pure logic. I/O (provider calls,
 * SQLite, websocket fan-out) is the daemon layer's job - this package
 * stays unit-testable with mock handles.
 */

export {
	type Budget,
	type BudgetCounters,
	type ExecutorHandle,
	type ExecutorTurnInput,
	type ExecutorTurnOutput,
	type GoalEvent,
	type GoalEventKind,
	type GoalEventSink,
	type GoalRun,
	type JudgeHandle,
	type JudgeHandleInput,
	type JudgeVerdict,
	type Receipt,
	type RunStatus,
	type StopReason,
	DEFAULT_BUDGET,
	SATISFIED_CONFIDENCE_FLOOR,
} from "./types";

export {
	IllegalTransitionError,
	canTransition,
	isTerminal,
	transition,
} from "./state-machine";

export {
	dissentExceeded,
	freshCounters,
	recordDissent,
	recordTurn,
	resolveBudget,
	shouldStop,
} from "./budget";

export {
	InvalidVerdictError,
	JudgeExecutorCollisionError,
	applyConfidenceFloor,
	assertDistinctJudge,
	makeJudgeHandle,
	validateVerdict,
} from "./judge";

export { buildReceipt } from "./receipt";

export { GoalLoop, type GoalLoopOptions } from "./goal-loop";
