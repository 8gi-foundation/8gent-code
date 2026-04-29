/**
 * Agent lifecycle state machine.
 *
 * Formalizes the lifecycle of a managed agent in the orchestration layer.
 * Replaces informal status flags scattered across pools with an explicit
 * state machine that supports suspend/resume and graceful shutdown.
 *
 * States:
 *   spawning   - construction in flight, executor not yet started
 *   running    - executor is running and consuming the turn budget
 *   suspended  - state serialized to durable storage, executor paused
 *   resumed    - rehydrated from snapshot, transient state before running
 *   completed  - terminal: executor returned a result
 *   failed     - terminal: executor threw
 *   terminated - terminal: explicit cancel or graceful shutdown
 *
 * Terminal states have no outgoing transitions.
 */

export type AgentLifecycleState =
	| "spawning"
	| "running"
	| "suspended"
	| "resumed"
	| "completed"
	| "failed"
	| "terminated";

export const TERMINAL_STATES: ReadonlySet<AgentLifecycleState> = new Set<AgentLifecycleState>([
	"completed",
	"failed",
	"terminated",
]);

/**
 * Allowed forward transitions. Any transition not listed here is rejected
 * by `isValidTransition()` and throws inside the lifecycle manager.
 */
export const ALLOWED_TRANSITIONS: Record<AgentLifecycleState, readonly AgentLifecycleState[]> = {
	spawning: ["running", "failed", "terminated"],
	running: ["suspended", "completed", "failed", "terminated"],
	suspended: ["resumed", "terminated"],
	resumed: ["running", "completed", "failed", "terminated"],
	completed: [],
	failed: [],
	terminated: [],
};

export function isValidTransition(
	from: AgentLifecycleState,
	to: AgentLifecycleState,
): boolean {
	return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminal(state: AgentLifecycleState): boolean {
	return TERMINAL_STATES.has(state);
}

/**
 * Minimal reproducible state for an agent. Persisted to workspace storage
 * on suspend; rehydrated on resume. Keep this serializable: no functions,
 * no class instances, no circular refs.
 */
export interface AgentLifecycleSnapshot {
	agentId: string;
	state: AgentLifecycleState;
	taskDescription: string;
	priority: number;
	/** Conversation turns captured at suspend time. Schema is owned by the executor. */
	conversationHistory: unknown[];
	/** Tool call in flight when suspended, if any. */
	pendingToolCall?: {
		name: string;
		args: unknown;
	};
	/** Free-form executor checkpoint payload. The executor decides what to put here. */
	checkpoint?: unknown;
	/** Optional tenant attribution for multi-tenant rollouts. */
	tenantId?: string;
	createdAt: string;
	updatedAt: string;
}
