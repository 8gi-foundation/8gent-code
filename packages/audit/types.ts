/**
 * Types for the access audit log.
 * Metadata only - never log the content of a record.
 */

export type ActorKind = "human" | "agent" | "system";
export type AccessOperation = "read" | "derive" | "export";

export interface LogAccessInput {
	actor: string;
	actorKind: ActorKind;
	targetTable: string;
	targetId: string;
	operation: AccessOperation;
	reason: string;
	sessionId?: string | null;
}

export interface AccessEvent {
	id: string;
	createdAt: number;
	actor: string;
	actorKind: ActorKind;
	targetTable: string;
	targetId: string;
	operation: AccessOperation;
	reason: string;
	sessionId: string | null;
}

export interface QueryAccessOptions {
	targetId?: string;
	targetTable?: string;
	actor?: string;
	since?: number;
	until?: number;
	limit?: number;
}

// ============================================
// Capability audit (issue #2091)
// ============================================

export type CapabilityOperation = "grant" | "revoke";

export interface LogCapabilityInput {
	actor: string;
	actorKind: ActorKind;
	skill: string;
	capability: string;
	operation: CapabilityOperation;
	reason: string;
	sessionId?: string | null;
}

export interface CapabilityEvent {
	id: string;
	createdAt: number;
	actor: string;
	actorKind: ActorKind;
	skill: string;
	capability: string;
	operation: CapabilityOperation;
	reason: string;
	sessionId: string | null;
}

export interface QueryCapabilityOptions {
	skill?: string;
	capability?: string;
	actor?: string;
	operation?: CapabilityOperation;
	since?: number;
	until?: number;
	limit?: number;
}

// ============================================
// Tool-call decision audit (issue #2756 step 3)
// ============================================

export type DecisionOutcome = "allow" | "deny";

/** Mirrors CapabilityRequest["kind"] in packages/permissions. */
export type DecisionRequestKind = "fs_read" | "fs_write" | "network" | "exec";

/** Which gate produced the final decision. */
export type DecisionGate = "capability-manifest" | "policy-rules";

export interface LogDecisionInput {
	tool: string;
	/** Agent id when known, otherwise a stable role like "agent". */
	actor: string;
	requestKind: DecisionRequestKind;
	/** Path, URL, or command - SECRET-SCRUBBED BY THE CALLER before logging. */
	requestDetail: string;
	decision: DecisionOutcome;
	gate: DecisionGate;
	reason: string;
	sessionId?: string | null;
}

export interface DecisionEvent {
	/** Monotonic chain position, 1-based. */
	seq: number;
	createdAt: number;
	sessionId: string | null;
	actor: string;
	tool: string;
	requestKind: DecisionRequestKind;
	requestDetail: string;
	decision: DecisionOutcome;
	gate: DecisionGate;
	reason: string;
	/** entry_hash of the previous entry (GENESIS_HASH for seq 1). */
	prevHash: string;
	/** SHA-256 over prevHash + the canonical payload of this entry. */
	entryHash: string;
}

export interface QueryDecisionOptions {
	tool?: string;
	sessionId?: string;
	decision?: DecisionOutcome;
	actor?: string;
	since?: number;
	until?: number;
	limit?: number;
}

export type ChainVerification =
	| { valid: true; entries: number; headHash: string }
	| { valid: false; entries: number; brokenAtSeq: number; reason: string };
