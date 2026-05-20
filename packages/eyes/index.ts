/**
 * @8gent/eyes - perception capability.
 *
 * This package defines the Eyes contract, a backend registry, and the
 * native AX backend (#1). Additional backends (remote-vlm, Windows UIA,
 * Linux AT-SPI) slot into the same registry per spec §8.5.
 *
 * Spec: docs/specs/EYES-SPEC.md
 * Backend rationale: docs/specs/EYES-BACKEND-AX-NATIVE.md
 *
 * Hands and eyes are independent body-parts. Eyes does not import from
 * @8gent/hands at type level; the agent loop wires Locator -> Point when
 * hands needs to act on what eyes located.
 *
 * History: the v0 backend (#2501) shelled out to the Homebrew `peekaboo`
 * binary. v0.2 replaces it with a bundled Swift bridge built from
 * packages/eyes/native/swift/ and installed at ~/.8gent/bin/8gent-ax-bridge.
 * No external CLI dependency.
 */

import type {
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
	TranscriptSegment,
	VideoEvent,
	VideoExtraction,
	VideoSpan,
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
export async function selectEyesBackend(preferenceOrder: string[]): Promise<EyesBackend | null> {
	for (const id of preferenceOrder) {
		const b = _backends.get(id);
		if (!b) continue;
		if (await b.available()) return b;
	}
	return null;
}

/**
 * Default failover order, mirroring the spec §5.
 *   1. ax-native (bundled Swift bridge, no install ceremony)
 *   2. remote-vlm (cloud, lowest fidelity for AX-driven locate)
 *
 * Backends not yet registered are skipped silently.
 */
export const DEFAULT_FAILOVER: readonly string[] = Object.freeze(["ax-native", "remote-vlm"]);

// ---------------------------------------------------------------------------
// First-party backends + perception-tier API. Re-exported here so consumers
// import a single surface.
// ---------------------------------------------------------------------------

export {
	axNativeBackend,
	createAxNativeEyes,
	probePermissions as probeAxNativePermissions,
	type AxNativeBackendOpts,
	type VisionProvider,
	type VisionRequest,
	type VisionResponse,
} from "./backends/ax-native.js";

// Compatibility re-export: existing call sites that imported the
// PeekabooBackendOpts shape get a same-shape type without churning every
// downstream import. New code should use AxNativeBackendOpts.
export type { AxNativeBackendOpts as PeekabooBackendOpts } from "./backends/ax-native.js";

export {
	checkPerceptionRemote,
	findActiveGrant,
	grantPerceptionRemote,
	isRemoteProvider,
	LOCAL_PROVIDERS,
	resetPerceptionTier,
	revokePerceptionRemote,
	type CheckArgs as PerceptionCheckArgs,
	type CheckResult as PerceptionCheckResult,
	type PerceptionGrant,
	type PerceptionTierScope,
} from "./perception-tier.js";

export { AnnotationCache, annotationKey } from "./cache.js";

// Auto-register the ax-native backend on first import. Backends gate
// themselves via available(); registering here means
// selectEyesBackend(DEFAULT_FAILOVER) just works without consumers having to
// wire each backend manually.
import { axNativeBackend as _axNativeBackend } from "./backends/ax-native.js";
registerEyesBackend(_axNativeBackend);
