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
