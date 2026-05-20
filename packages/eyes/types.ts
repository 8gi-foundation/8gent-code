/**
 * @8gent/eyes - perception types.
 *
 * Spec: docs/specs/EYES-SPEC.md
 *
 * These types are stable: hands consumes Locator, the agent loop consumes
 * Frame and Description, the trace store consumes ObservationEvent.
 * Backends implement the Eyes interface in index.ts against these types.
 */

export type Region = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };
export type Disposable = { dispose: () => void };

export interface CaptureOpts {
	// Default: focused display (the one containing the focused window) per §8.2.
	// "primary" targets the OS primary display. "all" returns one Frame per
	// display via captureAll(); never a stitched composite.
	displayId?: number | "all" | "primary";
	region?: Region;
	includeCursor?: boolean;
	format?: "png" | "jpeg";
}

export interface Frame {
	id: string;
	path: string;
	buffer?: Buffer;
	width: number; // logical (DPI-independent) pixels per §8.1
	height: number; // logical
	displayId: number;
	capturedAt: number;
	scale: number; // backing scale factor (e.g. 2 on retina). raw_pixels = width * scale.
	platform: "darwin" | "win32" | "linux"; // for cross-platform locator dispatch per §8.5
}

export interface AnnotatedElement {
	id: string;
	role: string;
	label?: string;
	value?: string;
	bbox: Region;
	enabled: boolean;
	app?: string;
	window?: string;
}

export interface AnnotatedFrame extends Frame {
	elements: AnnotatedElement[];
}

export type LocatorQuery =
	| { kind: "id"; id: string }
	| { kind: "label"; text: string; role?: string }
	| { kind: "role"; role: string; index?: number }
	| { kind: "describe"; text: string }
	| { kind: "coords"; x: number; y: number };

export interface Locator {
	target: { id: string } | { point: Point };
	confidence: number;
	source: "ax" | "vision" | "coords";
	bbox?: Region;
	rationale?: string;
}

export interface Description {
	summary: string;
	elements?: Array<{ role: string; label: string; bbox?: Region }>;
	tokens?: number;
	model?: string;
}

export type Predicate =
	| { kind: "element_visible"; query: LocatorQuery }
	| { kind: "element_gone"; query: LocatorQuery }
	| { kind: "text_present"; text: string; caseSensitive?: boolean }
	| { kind: "describe_matches"; prompt: string };

export interface WaitOpts {
	timeoutMs?: number;
	pollMs?: number;
	region?: Region;
}

export interface WaitResult {
	ok: boolean;
	matched?: Locator;
	elapsedMs: number;
}

export interface DiffOpts {
	region?: Region;
	/**
	 * Per-channel R/G/B delta in 0..255. A downscaled cell is considered
	 * "different" when any channel delta exceeds this value. Default: 30.
	 *
	 * Name reflects semantics: this is a per-channel intensity delta, not a
	 * pixel count. Tune lower for higher sensitivity.
	 */
	thresholdDelta?: number;
	/**
	 * @deprecated Use `thresholdDelta`. Same semantics (per-channel R/G/B
	 * delta in 0..255), retained as a back-compat alias. Will be removed in
	 * a future major. If both are set, `thresholdDelta` wins.
	 */
	thresholdPx?: number;
}

export interface FrameDiff {
	similarity: number;
	regions: Region[];
	pixelsDifferent: number;
}

export interface ObservationEvent {
	at: number;
	diff: FrameDiff;
	frame: Frame;
}

export interface ObserveOpts {
	thresholdSimilarity?: number;
	intervalMs?: number;
	region?: Region;
}

export interface BackendOpts {
	binaryPath?: string;
	modelHint?: string;
	tracePath?: string;
}

// ---------------------------------------------------------------------------
// Video extraction (VIDEO-INGESTION spec §7)
//
// These types are the frozen contract between the `extract_video` tool
// (#2632) and `packages/memory/video-extractor.ts` (#2633). The tool owns
// and produces a VideoExtraction; the video-extractor consumes it. All times
// are floating-point seconds, media-relative (0.0 = first frame), never
// wall-clock.
// ---------------------------------------------------------------------------

/** A visually observed event with a media-relative time span. */
export interface VideoEvent {
	start: number; // seconds, media-relative
	end: number; // seconds, media-relative
	description: string; // natural-language, from Marlin
}

/** A span of transcribed speech. */
export interface TranscriptSegment {
	start: number;
	end: number;
	text: string;
	speaker?: string; // reserved; diarization is a future lane, undefined for now
}

/** A located time span (Marlin find mode). */
export interface VideoSpan {
	start: number;
	end: number;
}

/** The full structured extraction of one video. */
export interface VideoExtraction {
	videoId: string; // content hash (sha256 of file bytes), stable id
	path: string; // absolute path at extraction time
	durationSec: number;
	chunked: boolean; // true if the video exceeded one Marlin window
	chunkCount: number;
	scene: string; // overall scene paragraph (merged if chunked)
	events: VideoEvent[]; // sorted by start, what was seen
	transcript: TranscriptSegment[]; // sorted by start, what was said
	find?: {
		// present only if a query was passed
		query: string;
		span: VideoSpan | null;
		formatOk: boolean;
	};
	models: { vision: string; audio: string };
	generatedAt: number; // epoch ms
}
