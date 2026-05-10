/**
 * Engagement loop - the orchestrator that decides when to engage struggle
 * mode and runs the eyes-worker + hands-queue triad while engaged.
 *
 * Spec: docs/specs/HANDEYES-SPEC.md §4 (engagement model) and §5
 * (architectural shape). This module owns:
 *
 *   - The 3 in-loop trigger detectors (find-zero-hits-twice, wait-for-timeout,
 *     click-without-screen-change). Trigger 4 (DoomLoopDetector) is wired by
 *     subscribing to the existing detector's 'stuck' event so we never
 *     re-instantiate it (spec §4.2).
 *   - StruggleHandle lifecycle: open, decrement ttl on each step, auto-exit
 *     after N consecutive forward-progress steps, hard exit on ttl exhaustion
 *     or sub-agent error.
 *   - Counter disarming on exit so the trigger that fired the engagement
 *     cannot immediately re-fire on the first post-exit call (spec §4.2).
 *
 * Race-condition contracts (spec §7) are enforced inline:
 *   - Mid-click animation: hands-queue captures a fresh frame at dispatch
 *     time; if it diverges from the locate frame above the similarity
 *     threshold, the click is held and the locate is re-run once.
 *   - AX-tree mutability: hands-queue serialises motor calls; eyes-worker
 *     annotates only between them.
 *   - Cache coherence: ad-hoc agent eyes calls share the singleton's
 *     annotation cache. The hands-queue and eyes-worker both go through
 *     the singleton; no parallel annotate paths.
 */

import { EventEmitter } from "node:events";
import type {
	DoomLoopDetector,
	DoomStuckEvent,
} from "../eight/tool-loop-detector.js";
import type { ObservationEvent } from "@8gent/eyes/types";
import type {
	StruggleHandle,
	StruggleReason,
	StruggleTriggerInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// Defaults (v0). Decisions logged in spec §8.
// ---------------------------------------------------------------------------

/** Default ttl for an auto-engaged struggle session, in agent steps. */
export const DEFAULT_TTL_STEPS = 8;

/** Forward-progress streak that triggers early exit. */
export const FORWARD_PROGRESS_EXIT_STREAK = 3;

/**
 * Per-trigger cooldown (ms). After a session exits, the same trigger source
 * cannot re-fire until this elapses. Prevents tight re-engagement loops on
 * post-exit calls when the screen has not yet stabilised.
 */
export const POST_EXIT_COOLDOWN_MS = 1_500;

/**
 * Material-change threshold for forward-progress detection. Any observe
 * event with similarity strictly below this counts as a material change.
 * Mirrors the eyes ObserveOpts default.
 */
export const MATERIAL_CHANGE_SIMILARITY = 0.95;

/**
 * Click-without-change window. After hands dispatches a click, we wait this
 * many ms for an observe event with sub-threshold similarity. If none arrives,
 * trigger 3 fires. Spec §4 row 3.
 */
export const CLICK_NO_CHANGE_WINDOW_MS = 1_500;

// ---------------------------------------------------------------------------
// Public events emitted by the loop. Consumers (handeyes-impl, tests, future
// trace-store recorders) subscribe to these instead of poking internals.
// ---------------------------------------------------------------------------

export type EngagementEvent =
	| "session:opened"
	| "session:step"
	| "session:exited"
	| "trigger:armed"
	| "trigger:fired";

export interface SessionOpenedPayload {
	handle: StruggleHandle;
}

export interface SessionStepPayload {
	handle: StruggleHandle;
	stepIndex: number;
	forwardProgress: boolean;
	streak: number;
}

export type SessionExitReason =
	| "explicit"
	| "ttl_exhausted"
	| "forward_progress_streak"
	| "subagent_error";

export interface SessionExitedPayload {
	handle: StruggleHandle;
	reason: SessionExitReason;
	steps: number;
	durationMs: number;
}

export interface TriggerFiredPayload {
	input: StruggleTriggerInput;
	cooldownActive: boolean;
}

// ---------------------------------------------------------------------------
// Hooks the loop calls into. Concrete wiring lives in handeyes-impl.ts; the
// loop itself is substrate-agnostic so tests can drive it without spawning
// real sub-agents.
// ---------------------------------------------------------------------------

export interface SessionWorkers {
	/** Tear down both sub-agents. Called on every exit path. Idempotent. */
	teardown: () => Promise<void>;
}

export interface EngagementLoopHooks {
	/**
	 * Spawn the eyes-worker + hands-queue sub-agents for this session. Called
	 * once per session, immediately after the handle is created. The returned
	 * SessionWorkers is held by the loop for the duration of the session and
	 * torn down on exit.
	 */
	spawnSession: (handle: StruggleHandle) => Promise<SessionWorkers>;

	/**
	 * Optional hook for tests / trace-store. Called once per step with the
	 * loop's internal view of progress. Errors thrown here are swallowed so
	 * a bad observer cannot crash the session.
	 */
	onStep?: (payload: SessionStepPayload) => void;
}

// ---------------------------------------------------------------------------
// Trigger detectors. Each one is a tiny stateful object the call site of an
// eyes / hands operation calls into. They live here (not in eyes / hands)
// because they are coordination state, not perception or motor state.
// ---------------------------------------------------------------------------

/**
 * Trigger 1: eyes.find returns zero hits twice in a row for the same query.
 * The query identity is a caller-supplied string (typically a normalised
 * JSON of the LocatorQuery).
 */
export class FindZeroHitsTwiceDetector {
	private lastZeroQuery: string | null = null;

	/**
	 * Record a find result. Returns true iff this is the second consecutive
	 * zero-hit on the same query (caller should fire the trigger).
	 */
	record(queryKey: string, hits: number): boolean {
		if (hits === 0) {
			if (this.lastZeroQuery === queryKey) {
				// Second consecutive zero. Reset so a third zero does not
				// re-fire on the same arming.
				this.lastZeroQuery = null;
				return true;
			}
			this.lastZeroQuery = queryKey;
			return false;
		}
		// Non-zero result clears the latch.
		this.lastZeroQuery = null;
		return false;
	}

	reset(): void {
		this.lastZeroQuery = null;
	}
}

/**
 * Trigger 2: wait_for timed out. Stateless; a single call from the eyes
 * wait_for site decides. Kept as a class for consistency and so callers can
 * configure per-source rate limiting later.
 */
export class WaitForTimeoutDetector {
	/** Returns the trigger input to feed the loop, or null on success. */
	record(timedOut: boolean): StruggleTriggerInput | null {
		if (!timedOut) return null;
		return { reason: "wait_for_timeout" };
	}
}

/**
 * Trigger 3: click followed by no observe-detected material change within
 * CLICK_NO_CHANGE_WINDOW_MS. Caller (hands-queue) records the click time,
 * then on every observe event calls observe(); the detector resolves the
 * pending click as either changed or not-changed.
 *
 * Degrades gracefully on the byte-equality v0 diff: false negatives only
 * (we miss clicks that did move pixels), never false positives (we never
 * say "changed" when it did not).
 */
export class ClickWithoutChangeDetector {
	private pending: { dispatchedAt: number; key: string } | null = null;

	constructor(
		private readonly windowMs: number = CLICK_NO_CHANGE_WINDOW_MS,
		private readonly threshold: number = MATERIAL_CHANGE_SIMILARITY,
		private readonly now: () => number = () => Date.now(),
	) {}

	recordClick(key: string): void {
		this.pending = { dispatchedAt: this.now(), key };
	}

	/**
	 * Resolve the pending click against an observe event. Returns the
	 * trigger input to fire when the window has elapsed without a material
	 * change. Caller invokes this both on observe events and on a
	 * post-window timeout tick.
	 */
	observe(event: ObservationEvent | null): StruggleTriggerInput | null {
		if (!this.pending) return null;
		const elapsed = this.now() - this.pending.dispatchedAt;

		if (event && event.diff.similarity < this.threshold) {
			// Material change inside the window: clear the pending state.
			this.pending = null;
			return null;
		}

		if (elapsed >= this.windowMs) {
			const key = this.pending.key;
			this.pending = null;
			return {
				reason: "click_no_observable_change",
				context: { clickKey: key, elapsedMs: elapsed },
			};
		}
		return null;
	}

	clear(): void {
		this.pending = null;
	}
}

// ---------------------------------------------------------------------------
// EngagementLoop: the orchestrator. Owns the three detectors above, the
// DoomLoopDetector subscription, the active StruggleHandle (at most one),
// the cooldown state, and the public event surface.
// ---------------------------------------------------------------------------

export interface EngagementLoopOpts {
	hooks: EngagementLoopHooks;
	doomDetector?: DoomLoopDetector;
	now?: () => number;
	/** Override default ttl for tests. */
	defaultTtlSteps?: number;
	/** Override default cooldown for tests. */
	postExitCooldownMs?: number;
}

export class EngagementLoop extends EventEmitter {
	readonly findZeroHits = new FindZeroHitsTwiceDetector();
	readonly waitForTimeout = new WaitForTimeoutDetector();
	readonly clickNoChange: ClickWithoutChangeDetector;

	private readonly hooks: EngagementLoopHooks;
	private readonly defaultTtl: number;
	private readonly cooldownMs: number;
	private readonly now: () => number;

	private active: StruggleHandle | null = null;
	private workers: SessionWorkers | null = null;
	private steps = 0;
	private startedAtMs = 0;
	private forwardStreak = 0;
	private cooldownByReason = new Map<StruggleReason, number>();
	private nextSessionId = 1;

	private doomDetector?: DoomLoopDetector;
	private doomListener?: (event: DoomStuckEvent) => void;

	constructor(opts: EngagementLoopOpts) {
		super();
		this.hooks = opts.hooks;
		this.defaultTtl = opts.defaultTtlSteps ?? DEFAULT_TTL_STEPS;
		this.cooldownMs = opts.postExitCooldownMs ?? POST_EXIT_COOLDOWN_MS;
		this.now = opts.now ?? (() => Date.now());
		this.clickNoChange = new ClickWithoutChangeDetector(
			CLICK_NO_CHANGE_WINDOW_MS,
			MATERIAL_CHANGE_SIMILARITY,
			this.now,
		);
		if (opts.doomDetector) this.attachDoomDetector(opts.doomDetector);
	}

	/**
	 * Subscribe to the existing DoomLoopDetector. Spec §4.2: "The handeyes
	 * coordinator MUST NOT re-instantiate the detector; it consumes the
	 * existing one." Uses duck-typed .on() so this also works against an
	 * older detector build that has not yet shipped the EventEmitter mixin
	 * (PR #2534 / RFC #2527 Option A) - in that case the subscription is a
	 * no-op and trigger 4 simply does not fire while the other three still
	 * do. The contract for the live emit is `DoomStuckEvent` from the
	 * detector module.
	 */
	attachDoomDetector(detector: DoomLoopDetector): void {
		// Detach any previous binding so re-attach is safe.
		this.detachDoomDetector();
		this.doomDetector = detector;
		const maybeOn = (detector as unknown as {
			on?: (event: string, listener: (event: DoomStuckEvent) => void) => void;
		}).on;
		if (typeof maybeOn !== "function") return;
		this.doomListener = (event) => {
			void this.fire({
				reason: "doom_loop_detected",
				context: {
					period: event.period,
					reps: event.reps,
					detectedAt: event.detectedAt,
					signatures: event.signatures,
				},
			});
		};
		maybeOn.call(detector, "stuck", this.doomListener);
	}

	private detachDoomDetector(): void {
		if (!this.doomDetector || !this.doomListener) return;
		const maybeOff = (this.doomDetector as unknown as {
			off?: (event: string, listener: (...args: unknown[]) => void) => void;
		}).off;
		if (typeof maybeOff === "function") {
			maybeOff.call(this.doomDetector, "stuck", this.doomListener as never);
		}
		this.doomListener = undefined;
		this.doomDetector = undefined;
	}

	// -----------------------------------------------------------------------
	// Trigger arming. Call sites in eyes / hands tools call these instead of
	// poking the detectors directly. Each returns the live StruggleHandle if
	// engagement fired, or null otherwise.
	// -----------------------------------------------------------------------

	armFindResult(queryKey: string, hits: number): Promise<StruggleHandle | null> {
		const fired = this.findZeroHits.record(queryKey, hits);
		if (!fired) return Promise.resolve(null);
		return this.fire({
			reason: "find_zero_hits_repeated",
			context: { queryKey },
		});
	}

	armWaitForResult(timedOut: boolean): Promise<StruggleHandle | null> {
		const input = this.waitForTimeout.record(timedOut);
		if (!input) return Promise.resolve(null);
		return this.fire(input);
	}

	armClickDispatched(key: string): void {
		this.clickNoChange.recordClick(key);
	}

	armClickObservation(
		event: ObservationEvent | null,
	): Promise<StruggleHandle | null> {
		const input = this.clickNoChange.observe(event);
		if (!input) return Promise.resolve(null);
		return this.fire(input);
	}

	// -----------------------------------------------------------------------
	// Session control.
	// -----------------------------------------------------------------------

	/** Returns the current active session, if any. */
	current(): StruggleHandle | null {
		return this.active;
	}

	/**
	 * Engage struggle mode explicitly. Idempotent on the same engagement: if
	 * a session is already active, returns the existing handle.
	 */
	async engage(
		reason: StruggleReason | string,
		ttlSteps?: number,
	): Promise<StruggleHandle> {
		if (this.active) return this.active;
		return this.openSession(this.coerceReason(reason), ttlSteps);
	}

	/**
	 * Step the active session forward by one. Returns the post-step handle
	 * so callers can decide whether to keep going. Auto-exits when:
	 *   - ttl reaches zero
	 *   - forward-progress streak reaches FORWARD_PROGRESS_EXIT_STREAK
	 */
	async step(forwardProgress: boolean): Promise<StruggleHandle | null> {
		if (!this.active) return null;
		this.steps += 1;
		this.active.ttlSteps -= 1;

		if (forwardProgress) {
			this.forwardStreak += 1;
		} else {
			this.forwardStreak = 0;
		}

		const payload: SessionStepPayload = {
			handle: this.active,
			stepIndex: this.steps,
			forwardProgress,
			streak: this.forwardStreak,
		};
		this.emit("session:step", payload);
		try {
			this.hooks.onStep?.(payload);
		} catch {
			// Observer errors must never crash the session.
		}

		if (this.forwardStreak >= FORWARD_PROGRESS_EXIT_STREAK) {
			await this.exit("forward_progress_streak");
			return null;
		}
		if (this.active.ttlSteps <= 0) {
			await this.exit("ttl_exhausted");
			return null;
		}
		return this.active;
	}

	/** Explicit teardown. Idempotent on already-exited handles. */
	async exitExplicit(handle?: StruggleHandle): Promise<void> {
		if (!this.active) return;
		if (handle && handle.id !== this.active.id) return;
		await this.exit("explicit");
	}

	/** Mark a sub-agent failure and tear down. */
	async failSubagent(): Promise<void> {
		if (!this.active) return;
		await this.exit("subagent_error");
	}

	/** Drop event listeners and any active session. */
	async dispose(): Promise<void> {
		this.detachDoomDetector();
		if (this.active) await this.exit("explicit");
		this.removeAllListeners();
	}

	// -----------------------------------------------------------------------
	// Internals.
	// -----------------------------------------------------------------------

	private async fire(input: StruggleTriggerInput): Promise<StruggleHandle | null> {
		const cooldownActive = this.isOnCooldown(input.reason);
		this.emit("trigger:fired", { input, cooldownActive } satisfies TriggerFiredPayload);
		if (cooldownActive) return null;
		if (this.active) return this.active;
		return this.openSession(input.reason);
	}

	private isOnCooldown(reason: StruggleReason): boolean {
		const until = this.cooldownByReason.get(reason);
		if (!until) return false;
		if (this.now() >= until) {
			this.cooldownByReason.delete(reason);
			return false;
		}
		return true;
	}

	private async openSession(
		reason: StruggleReason,
		ttlSteps?: number,
	): Promise<StruggleHandle> {
		const ttl = ttlSteps ?? this.defaultTtl;
		const handle: StruggleHandle = {
			id: `hndls-${this.nextSessionId++}-${this.now()}`,
			startedAt: this.now(),
			reason,
			ttlSteps: ttl,
		};
		this.active = handle;
		this.steps = 0;
		this.forwardStreak = 0;
		this.startedAtMs = this.now();

		try {
			this.workers = await this.hooks.spawnSession(handle);
		} catch (err) {
			// Failed to spawn workers: clear state and rethrow so the caller
			// surfaces the error. Cooldown is NOT set (we never engaged).
			this.active = null;
			this.workers = null;
			throw err;
		}
		this.emit("session:opened", { handle } satisfies SessionOpenedPayload);
		return handle;
	}

	private async exit(reason: SessionExitReason): Promise<void> {
		const handle = this.active;
		if (!handle) return;
		const workers = this.workers;
		this.active = null;
		this.workers = null;

		// Disarm the trigger that fired this engagement so it cannot
		// immediately re-fire on the first post-exit call (spec §4.2).
		this.findZeroHits.reset();
		this.clickNoChange.clear();
		this.cooldownByReason.set(handle.reason, this.now() + this.cooldownMs);

		if (workers) {
			try {
				await workers.teardown();
			} catch {
				// Teardown failures are logged via the orchestrator; not
				// surfaced here since the session is already considered
				// closed from the loop's perspective.
			}
		}
		this.emit("session:exited", {
			handle,
			reason,
			steps: this.steps,
			durationMs: this.now() - this.startedAtMs,
		} satisfies SessionExitedPayload);
	}

	private coerceReason(reason: StruggleReason | string): StruggleReason {
		const known: StruggleReason[] = [
			"explicit_self_diagnosis",
			"find_zero_hits_repeated",
			"wait_for_timeout",
			"click_no_observable_change",
			"doom_loop_detected",
		];
		if ((known as string[]).includes(reason)) return reason as StruggleReason;
		return "explicit_self_diagnosis";
	}
}
