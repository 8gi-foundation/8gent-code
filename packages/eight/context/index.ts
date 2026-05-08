/**
 * Incremental Context Compression — public surface.
 * Issue #2420.
 */

export {
	type Artifact,
	type ArtifactKind,
	type ArtifactRegistryConfig,
	ArtifactRegistry,
	DEFAULT_REGISTRY_CONFIG,
} from "./artifact-registry";
export {
	type Milestone,
	type MilestoneKind,
	MilestoneDetector,
} from "./milestone-detector";
export {
	type CompressionMetric,
	type CompressionTrigger,
	type MetricsSnapshot,
	CompressionMetrics,
	extractPaths,
	intersectionRatio,
} from "./metrics";
export {
	type IncrementalCompressorConfig,
	type SessionType,
	IncrementalContextCompressor,
	presetFor,
} from "./incremental-compressor";
