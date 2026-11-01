/**
 * @8gent/handeyes - sensorimotor coordination capability.
 *
 * The third body-part. Where `@8gent/hands` is motor-only and `@8gent/eyes`
 * is perception-only, `@8gent/handeyes` is the package that depends on
 * BOTH. It engages selectively when the agent is observably stuck on a
 * hands-only or eyes-only flow; the default path stays the cheap sequential
 * one (eyes.find -> hands.click).
 *
 * Architectural anchor: handeyes is multi-agent orchestration applied to
 * body-parts. It reuses the existing spawn_agent / check_agent /
 * message_agent / merge_agent_work primitives in packages/orchestration and
 * packages/ai/tools.ts; no new orchestration substrate is introduced.
 *
 * This file is the contract surface only. Per issue #2526, the engagement
 * loop, the eyes-worker spawning, the hands-queue serialisation, and the
 * DoomLoopDetector hook all land in a follow-up PR after the perceptual
 * diff (#2525) is in. The contract here does not depend on that diff
 * landing first.
 *
 * Spec: docs/specs/HANDEYES-SPEC.md
 */

import type {
	ClickOpts,
	ConfirmOpts,
	LocateClickResult,
	LocatorQuery,
	Point,
	Predicate,
	StruggleHandle,
	StruggleReason,
	VerifyOpts,
	VerifyResult,
} from "./types.js";

export type {
	ClickOpts,
	ConfirmOpts,
	LocateClickResult,
	LocatorQuery,
	Point,
	Predicate,
	StruggleHandle,
	StruggleReason,
	StruggleTriggerInput,
	VerifyOpts,
	VerifyResult,
} from "./types.js";

/**
 * The Handeyes contract. Backends (read: coordinators) implement this; the
 * agent loop and the future headless CLI consume it.
 *
 * The four compound actions are the agent's primary surface; the two
 * struggle-mode calls are an explicit self-rescue lever for when an agent
 * can self-diagnose that it is stuck without waiting for the auto-triggers.
 */
export interface Handeyes {
	readonly id: string;
	readonly available: boolean;

	/**
	 * Locate a target by query, then click it. The most common compound
	 * pattern. Implementations SHOULD honour ClickOpts.locateRetries before
	 * declaring no_match; SHOULD honour ClickOpts.verifyChanged by chaining
	 * an observe()-driven confirmation.
	 */
	locateAndClick(
		query: LocatorQuery,
		opts?: ClickOpts,
	): Promise<LocateClickResult>;

	/**
	 * Click a known point, then poll a predicate to verify the click had the
	 * intended effect. Retries up to VerifyOpts.maxRetries on failure. This
	 * is the building block for "did anything actually happen?" loops.
	 */
	clickAndVerify(
		point: Point,
		expected: Predicate,
		opts?: VerifyOpts,
	): Promise<VerifyResult>;

	/**
	 * Type a string into the focused field, then optionally re-locate the
	 * target field and confirm its value reflects what was typed. This
	 * catches the IME / focus-stolen / wrong-field-focused failure modes
	 * that otherwise look identical to success at the hands layer.
	 */
	typeAndConfirm(
		text: string,
		expectedField?: LocatorQuery,
		opts?: ConfirmOpts,
	): Promise<VerifyResult>;

	/**
	 * Explicit self-rescue. The agent calls this when it has self-diagnosed
	 * that it is stuck and wants the eyes-worker / hands-queue / coordinator
	 * triad spun up immediately, without waiting for any auto-trigger to
	 * fire. The returned StruggleHandle is required to exit; engagement is
	 * also bounded by ttlSteps (default backend-defined).
	 *
	 * @param reason - One of the standard StruggleReason values, or a free
	 *   string for novel cases. The audit trail records the literal value
	 *   regardless. Prefer enum values where possible for trace queryability.
	 */
	engageStruggleMode(
		reason: StruggleReason | string,
		ttlSteps?: number,
	): Promise<StruggleHandle>;

	/**
	 * Tear down a struggle session. Idempotent on already-exited handles.
	 * Backends MUST also auto-exit when the trigger heuristics in spec §4
	 * indicate forward progress has resumed; this call is for the explicit
	 * agent-driven exit path.
	 */
	exitStruggleMode(handle: StruggleHandle): Promise<void>;
}

// ---------------------------------------------------------------------------
// Adapter registry.
//
// Mirrors the EyesBackend / EyesBackend pattern. Adapters register themselves
// at module load; the agent loop selects the first available adapter via
// selectHandeyesAdapter(). No singleton is created at import time; that is
// the consumer's job, kept consistent with how Eyes is wired in the agent
// tools.
// ---------------------------------------------------------------------------

export interface HandeyesAdapter {
	readonly id: string;
	/**
	 * The adapter is only usable when both an Eyes backend and a usable
	 * hands runtime are available. available() MUST NOT spawn anything; it
	 * is a probe.
	 */
	readonly available: () => Promise<boolean>;
	readonly create: (opts?: HandeyesAdapterOpts) => Handeyes;
}

export interface HandeyesAdapterOpts {
	/**
	 * Optional tag for trace-store filtering; lets multiple coordinators
	 * coexist (e.g. one per app focus) without trace cross-contamination.
	 */
	scope?: string;
}

const _adapters = new Map<string, HandeyesAdapter>();

export function registerHandeyesAdapter(a: HandeyesAdapter): void {
	_adapters.set(a.id, a);
}

export function listHandeyesAdapters(): HandeyesAdapter[] {
	return [..._adapters.values()];
}

export function getHandeyesAdapter(id: string): HandeyesAdapter | undefined {
	return _adapters.get(id);
}

/**
 * Pick the first available adapter in the supplied preference order.
 * Returns null if nothing is available; callers should surface an actionable
 * "engagement unavailable" message to the agent rather than throw.
 */
export async function selectHandeyesAdapter(
	preferenceOrder: string[],
): Promise<HandeyesAdapter | null> {
	for (const id of preferenceOrder) {
		const a = _adapters.get(id);
		if (!a) continue;
		if (await a.available()) return a;
	}
	return null;
}

/**
 * Default preference order for the v0 adapter set. The orchestrator-backed
 * adapter (handeyes-impl.ts) registers itself at module load when imported,
 * so consumers should import `./handeyes-impl` (or the convenience
 * `configureOrchestratorAdapter` re-exported below) before calling
 * `selectHandeyesAdapter(DEFAULT_ADAPTER_ORDER)`.
 */
export const DEFAULT_ADAPTER_ORDER: readonly string[] = Object.freeze([
	"orchestrator",
]);

/**
 * Convenience entrypoint. Importing this triggers registration of the
 * orchestrator adapter as a side effect; calling it wires the eyes / hands
 * dependencies the adapter needs. Consumers that want a fully wired Handeyes
 * with one call go through here.
 */
export {
	configureOrchestratorAdapter,
	orchestratorAdapter,
	OrchestratorHandeyes,
} from "./handeyes-impl.js";

// Side-effect re-export of the engagement-loop primitives so tests and
// future inline-coordinator adapters can build on the same trigger
// detectors without reaching into private files.
export {
	ClickWithoutChangeDetector,
	DEFAULT_TTL_STEPS,
	EngagementLoop,
	FindZeroHitsTwiceDetector,
	FORWARD_PROGRESS_EXIT_STREAK,
	POST_EXIT_COOLDOWN_MS,
	WaitForTimeoutDetector,
} from "./engagement-loop.js";

export type {
	EngagementLoopHooks,
	EngagementLoopOpts,
	SessionExitedPayload,
	SessionExitReason,
	SessionOpenedPayload,
	SessionStepPayload,
	SessionWorkers,
	TriggerFiredPayload,
} from "./engagement-loop.js";
