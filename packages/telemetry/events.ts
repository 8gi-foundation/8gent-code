/**
 * Telemetry event taxonomy.
 *
 * Three event kinds gate Wave 4 multi-tenant rollout:
 *   - llm     : every model request (tokens, latency, cost estimate)
 *   - vessel  : every vessel/daemon RPC (endpoint, duration)
 *   - storage : every storage operation (bytes read/written)
 *
 * Every event carries `tenantId`. Without it, the event is rejected
 * by `recordEvent()` so we cannot accidentally ship un-attributed
 * traffic to Loki.
 */

export type TelemetryKind = "llm" | "vessel" | "storage" | "lifecycle";

/**
 * Mirror of `AgentLifecycleState` from `@8gent/types`. Duplicated as a string
 * union here to avoid pulling a runtime dep on `@8gent/types` into telemetry.
 * Keep in sync with `packages/types/agent-lifecycle.ts`.
 */
export type AgentLifecycleStateName =
	| "spawning"
	| "running"
	| "suspended"
	| "resumed"
	| "completed"
	| "failed"
	| "terminated";

/** Common envelope on every emitted event. */
export interface TelemetryBase {
	/** Event kind discriminator. */
	kind: TelemetryKind;
	/** Tenant attribution. REQUIRED. */
	tenantId: string;
	/** Optional Clerk user ID (if different from tenantId). */
	clerkId?: string;
	/** ISO-8601 timestamp. Filled by emitter if absent. */
	ts?: string;
	/** Optional session correlation. */
	sessionId?: string;
	/** Daemon channel: os, app, telegram, discord, api, delegation, computer. */
	channel?: string;
	/** OTel-compatible trace id (32 hex chars). */
	traceId?: string;
	/** OTel-compatible span id (16 hex chars). */
	spanId?: string;
	/** Parent span id for nested operations. */
	parentSpanId?: string;
	/** Span start time (unix nanos). */
	startTimeUnixNano?: number;
	/** Span end time (unix nanos). */
	endTimeUnixNano?: number;
}

/** LLM request — every model call instruments one of these. */
export interface LLMEvent extends TelemetryBase {
	kind: "llm";
	provider: string;
	model: string;
	/** Tokens in prompt + system + tool definitions. */
	promptTokens: number;
	/** Tokens in completion + tool calls. */
	completionTokens: number;
	totalTokens?: number;
	/** Wall-clock latency including network. */
	latencyMs: number;
	/** Estimated cost in USD (0 for local). */
	costUsd?: number;
	/** Whether the request streamed. */
	streamed?: boolean;
	/** Whether the call returned an error. */
	error?: string;
	/** Whether tool calling was used. */
	usedTools?: boolean;
}

/** Vessel call — daemon RPC, board-vessel forwarding, or sub-agent invocation. */
export interface VesselEvent extends TelemetryBase {
	kind: "vessel";
	endpoint: string;
	durationMs: number;
	/** HTTP / WS status code. 0 if not applicable. */
	status?: number;
	/** Bytes sent + received over the wire. */
	bytesIn?: number;
	bytesOut?: number;
	error?: string;
}

/** Storage op — file write, KV write, blob read. */
export interface StorageEvent extends TelemetryBase {
	kind: "storage";
	op: "read" | "write" | "delete" | "list";
	/** Logical store name (memory.db, blob, kv, qdrant). */
	store: string;
	/** Bytes touched. */
	bytes: number;
	durationMs?: number;
	error?: string;
}

/**
 * Lifecycle event — every agent state transition emits one of these.
 * Powers the lifecycle audit trail and feeds the orchestration dashboard.
 */
export interface LifecycleEvent extends TelemetryBase {
	kind: "lifecycle";
	agentId: string;
	state: AgentLifecycleStateName;
	prevState?: AgentLifecycleStateName;
	taskDescription?: string;
	priority?: number;
	reason?: string;
	/** Wall-clock duration of the previous state, if known. */
	durationMs?: number;
	error?: string;
}

export type TelemetryEvent = LLMEvent | VesselEvent | StorageEvent | LifecycleEvent;

/** Type guard helpers. */
export function isLLMEvent(e: TelemetryEvent): e is LLMEvent {
	return e.kind === "llm";
}
export function isVesselEvent(e: TelemetryEvent): e is VesselEvent {
	return e.kind === "vessel";
}
export function isStorageEvent(e: TelemetryEvent): e is StorageEvent {
	return e.kind === "storage";
}
export function isLifecycleEvent(e: TelemetryEvent): e is LifecycleEvent {
	return e.kind === "lifecycle";
}
