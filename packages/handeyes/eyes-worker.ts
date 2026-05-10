/**
 * Eyes worker - thin wrapper around eyes.observe() that publishes diff
 * events to the orchestrator bus while a struggle session is active.
 *
 * Architectural rationale (spec §5.2): one worker per session, never many.
 * eyes.observe() is already a continuous stream; spawning multiple workers
 * would produce duplicate diff events and burn capture CPU. This worker
 * captures once per interval and fans out to every listener on the bus.
 *
 * Why this is not a sub-agent process:
 *   The "sub-agent" framing in spec §5 is logical, not physical. Spawning a
 *   real CLI sub-agent for a tight observe loop would burn a model slot and
 *   add round-trip latency. The same isolation guarantees (single observer,
 *   teardown on session exit, bus-routed events) come from a typed worker
 *   object that runs in-process and is owned by the EngagementLoop. The
 *   physical-sub-agent path stays available for future adapters that need
 *   it; this file is the v0 in-process implementation.
 */

import type { Eyes, ObservationEvent, ObserveOpts, Region } from "@8gent/eyes";
import type { OrchestratorBus } from "../orchestration/orchestrator-bus.js";

export interface EyesWorkerOpts {
	/** Singleton Eyes instance the worker drives. Shared with ad-hoc agent calls. */
	eyes: Eyes;
	/** Bus to publish ObservationEvents on. Defaults to getOrchestratorBus(). */
	bus: OrchestratorBus;
	/** Session id used to scope the bus event names. */
	sessionId: string;
	/** Observe loop config; passed through to eyes.observe(). */
	observe?: ObserveOpts;
	/** Region of interest. Default: full focused display. */
	region?: Region;
}

export interface EyesWorker {
	readonly sessionId: string;
	/** Stop the observe loop and detach from the bus. Idempotent. */
	stop(): void;
	/** True until stop() is called. */
	readonly active: boolean;
}

/**
 * Bus event name produced by an active worker. The session id is part of the
 * event so multiple sessions on the same bus do not cross-contaminate (a
 * defensive choice; the loop only allows one active session at a time).
 */
export function observationEventName(sessionId: string): string {
	return `handeyes:${sessionId}:observation`;
}

export function startEyesWorker(opts: EyesWorkerOpts): EyesWorker {
	const observeOpts: ObserveOpts = {
		thresholdSimilarity: opts.observe?.thresholdSimilarity ?? 0.95,
		intervalMs: opts.observe?.intervalMs ?? 250,
		region: opts.observe?.region ?? opts.region,
	};

	let active = true;
	const eventName = observationEventName(opts.sessionId);

	const disposable = opts.eyes.observe((event: ObservationEvent) => {
		if (!active) return;
		opts.bus.emit(eventName, event);
	}, observeOpts);

	return {
		sessionId: opts.sessionId,
		get active() {
			return active;
		},
		stop(): void {
			if (!active) return;
			active = false;
			try {
				disposable.dispose();
			} catch {
				// Disposal failures are non-fatal; the worker is already
				// considered stopped.
			}
		},
	};
}
