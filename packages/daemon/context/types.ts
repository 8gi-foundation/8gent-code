/**
 * Shared types for the daemon context-compression module.
 *
 * The pieces in `packages/daemon/context/*` form a session-aware, artifact-
 * preserving compression layer that sits at the daemon boundary. It is
 * complementary to (not a replacement for) the in-process compaction in
 * `packages/eight/compaction.ts`: this layer adds the artifact registry,
 * milestone-event triggers, and incremental summary chaining that the
 * agent-level compactor does not own.
 */

export interface Message {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	name?: string;
}

export interface ContextUsage {
	input: number;
	output: number;
	total: number;
	contextWindow: number;
	ratio: number;
	remaining: number;
}

export interface FileArtifact {
	path: string;
	lastState: string;
	lastMentioned: number;
}

export interface EntityArtifact {
	name: string;
	type: string;
	description: string;
	lastMentioned: number;
}

export interface DecisionArtifact {
	timestamp: number;
	summary: string;
	rationale: string;
}

export interface ArtifactRegistry {
	files: Map<string, FileArtifact>;
	entities: Map<string, EntityArtifact>;
	decisions: DecisionArtifact[];
}

export interface SerializedRegistry {
	files: FileArtifact[];
	entities: EntityArtifact[];
	decisions: DecisionArtifact[];
}

export type MilestoneEvent =
	| { type: "task-complete"; description: string }
	| { type: "file-saved"; path: string }
	| { type: "test-passed"; suite?: string }
	| { type: "tool-success"; toolName: string }
	| { type: "manual"; description: string };

export interface MilestoneCheckpoint {
	id: string;
	createdAt: number;
	trigger: "milestone" | "near-limit" | "manual";
	event?: MilestoneEvent;
	tokensBefore: number;
	tokensAfter: number;
	messagesRemoved: number;
	summary: string;
}

export interface CompressionInput {
	messages: Message[];
	previousSummary: string | null;
	registry: ArtifactRegistry;
	keepRecentTokens?: number;
}

export interface CompressionOutput {
	messages: Message[];
	summary: string;
	tokensBefore: number;
	tokensAfter: number;
	messagesRemoved: number;
}
