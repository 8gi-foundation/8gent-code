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
	displayId?: number;
	region?: Region;
	includeCursor?: boolean;
	format?: "png" | "jpeg";
}

export interface Frame {
	id: string;
	path: string;
	buffer?: Buffer;
	width: number;
	height: number;
	displayId: number;
	capturedAt: number;
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
