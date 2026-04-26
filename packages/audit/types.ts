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
