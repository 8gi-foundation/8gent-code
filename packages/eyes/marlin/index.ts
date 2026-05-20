/**
 * @8gent/eyes/marlin — video-ingestion client side.
 *
 * The TypeScript half of the video lane (VIDEO-INGESTION spec). The Python
 * sidecar (`python -m marlin_sidecar`, #2631) is the other half and is built
 * separately; this package speaks to it over stdio JSON-RPC.
 *
 * Public surface:
 *   - extractVideo / formatExtractVideoResult — the `extract_video` handler.
 *   - checkVideoCapability — the off-by-default capability gate.
 *   - chunk-merge primitives — pure, testable §8 logic.
 *   - MarlinSidecarClient — the JSON-RPC client (injectable spawn).
 */

export {
	checkVideoCapability,
	marlinVenvDir,
	marlinVenvPython,
	type CapabilityStatus,
} from "./capability.js";
export {
	jaccard,
	MAX_CHUNK_SEC,
	mergeEvents,
	mergeScenes,
	planChunks,
	rebaseEvents,
	type CaptionResult,
	type ChunkWindow,
} from "./chunk-merge.js";
export {
	defaultSpawnSpec,
	extractVideo,
	formatExtractVideoResult,
	type ExtractVideoArgs,
	type ExtractVideoDeps,
	type ExtractVideoError,
	type ExtractVideoMode,
	type ExtractVideoResult,
} from "./extract-video.js";
export {
	MarlinSidecarClient,
	SidecarProcessError,
	SidecarRpcError,
	type RpcError,
	type SidecarClientOpts,
	type SidecarSpawnSpec,
} from "./jsonrpc-client.js";
export {
	matchesVideoMagic,
	resolveVideoPath,
	sniffIsVideo,
	type VideoPathResult,
} from "./video-path.js";
