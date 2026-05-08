/**
 * Public API for the daemon context-compression module.
 *
 * Solves issue #2420: incremental context compression for long-running
 * sessions, with a never-compressed artifact registry that survives
 * every compression pass verbatim.
 */

export { ContextTracker, estimateExchangeTokens } from "./context-tracker";
export type { ContextTrackerOptions } from "./context-tracker";

export {
	ArtifactRegistryStore,
	extractFilesFromText,
} from "./artifact-registry";

export {
	CompressionEngine,
	buildCompressionInput,
	buildCompressionPrompt,
	findCutPoint,
	renderRegistry,
} from "./compression-engine";
export type {
	CompressionEngineOptions,
	SummarizerCall,
} from "./compression-engine";

export { MilestoneCheckpointer } from "./milestone-checkpoint";
export type {
	CheckpointAttempt,
	MilestoneCheckpointerOptions,
} from "./milestone-checkpoint";

export { SessionContextManager } from "./session-context-manager";
export type { SessionContextManagerOptions } from "./session-context-manager";

export type {
	ArtifactRegistry,
	CompressionInput,
	CompressionOutput,
	ContextUsage,
	DecisionArtifact,
	EntityArtifact,
	FileArtifact,
	Message,
	MilestoneCheckpoint,
	MilestoneEvent,
	SerializedRegistry,
} from "./types";
