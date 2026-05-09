/**
 * @8gent/eyes - perception capability.
 *
 * This package defines the Eyes contract and a backend registry. It does not
 * include any backend implementation; the first backend (Peekaboo) lands in
 * a follow-up PR per docs/specs/EYES-BACKEND-PEEKABOO.md.
 *
 * Spec: docs/specs/EYES-SPEC.md
 *
 * Hands and eyes are independent body-parts. Eyes does not import from
 * @8gent/hands at type level; the agent loop wires Locator -> Point when
 * hands needs to act on what eyes located.
 *
 * Closes nothing yet (spec PR). Issue: #2496.
 */

import type {
	AnnotatedFrame,
	BackendOpts,
	CaptureOpts,
	Description,
	Disposable,
	DiffOpts,
	Frame,
	FrameDiff,
	Locator,
	LocatorQuery,
	ObservationEvent,
	ObserveOpts,
	Predicate,
	WaitOpts,
	WaitResult,
} from "./types.js";

export type {
	AnnotatedElement,
	AnnotatedFrame,
	BackendOpts,
	CaptureOpts,
	Description,
	DiffOpts,
	Disposable,
	Frame,
	FrameDiff,
	Locator,
	LocatorQuery,
	ObservationEvent,
	ObserveOpts,
	Point,
	Predicate,
	Region,
	WaitOpts,
	WaitResult,
} from "./types.js";

/**
 * The Eyes contract. Backends implement this; the agent loop and the
 * headless CLI consume it.
 */
export interface Eyes {
	readonly id: string;
	readonly available: boolean;
	readonly backend: string;

	// Default targets the focused display per spec §8.2. Pass `displayId: "all"`
	// to use captureAll() instead; stitched composites are not supported.
	capture(opts?: CaptureOpts): Promise<Frame>;
	captureAll(opts?: Omit<CaptureOpts, "displayId">): Promise<Frame[]>;

	annotate(frame: Frame): Promise<AnnotatedFrame>;
	locate(query: LocatorQuery, frame?: AnnotatedFrame): Promise<Locator[]>;
	describe(frame: Frame, prompt?: string): Promise<Description>;
	wait_for(predicate: Predicate, opts?: WaitOpts): Promise<WaitResult>;
	diff(a: Frame, b: Frame, opts?: DiffOpts): Promise<FrameDiff>;
	observe(handler: (e: ObservationEvent) => void, opts?: ObserveOpts): Disposable;
}

/**
 * Backend descriptor. Backends register themselves with the registry below.
 */
export interface EyesBackend {
	readonly id: string;
	readonly platforms: Array<"darwin" | "linux" | "win32">;
	readonly minOSVersion?: string;
	readonly available: () => Promise<boolean>;
	readonly create: (opts?: BackendOpts) => Eyes;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const _backends = new Map<string, EyesBackend>();

export function registerEyesBackend(b: EyesBackend): void {
	_backends.set(b.id, b);
}

export function listEyesBackends(): EyesBackend[] {
	return [..._backends.values()];
}

export function getEyesBackend(id: string): EyesBackend | undefined {
	return _backends.get(id);
}

/**
 * Pick the first available backend in the supplied preference order. Returns
 * null if nothing is available; callers should surface an actionable install
 * prompt rather than throw.
 */
export async function selectEyesBackend(
	preferenceOrder: string[],
): Promise<EyesBackend | null> {
	for (const id of preferenceOrder) {
		const b = _backends.get(id);
		if (!b) continue;
		if (await b.available()) return b;
	}
	return null;
}

/**
 * Default failover order, mirroring the spec §5.
 *   1. ax-native (lowest latency, no install)
 *   2. peekaboo (subprocess, install required)
 *   3. remote-vlm (cloud, lowest fidelity for AX-driven locate)
 *
 * Backends not yet registered are skipped silently.
 */
export const DEFAULT_FAILOVER: readonly string[] = Object.freeze([
	"ax-native",
	"peekaboo",
	"remote-vlm",
]);
