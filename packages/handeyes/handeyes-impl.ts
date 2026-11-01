/**
 * Orchestrator-backed Handeyes implementation.
 *
 * Wires the EngagementLoop, the eyes-worker, and the hands-queue into the
 * 5-method Handeyes contract from index.ts. The five compound actions land
 * here; the contract surface stays in index.ts unchanged.
 *
 * Spec: docs/specs/HANDEYES-SPEC.md (engagement model §4, architectural
 * shape §5, race conditions §7).
 */

import type { DoomLoopDetector } from "../eight/tool-loop-detector.js";
import type { Eyes, Locator, LocatorQuery, Point } from "@8gent/eyes";
import type {
	HandsDriver,
	OpResult,
	Point as HandsPoint,
} from "@8gent/hands";
import {
	getOrchestratorBus,
	type OrchestratorBus,
} from "../orchestration/orchestrator-bus.js";
import {
	EngagementLoop,
	type EngagementLoopHooks,
	type SessionWorkers,
} from "./engagement-loop.js";
import { observationEventName, startEyesWorker } from "./eyes-worker.js";
import { createHandsQueue, type HandsQueue } from "./hands-queue.js";
import {
	type HandeyesAdapter,
	type Handeyes,
	registerHandeyesAdapter,
} from "./index.js";
import type {
	ClickOpts,
	ConfirmOpts,
	LocateClickResult,
	Predicate,
	StruggleHandle,
	StruggleReason,
	VerifyOpts,
	VerifyResult,
} from "./types.js";

const DEFAULT_LOCATE_RETRIES = 1;
const DEFAULT_VERIFY_RETRIES = 2;
const DEFAULT_VERIFY_TIMEOUT_MS = 3_000;
const DEFAULT_CLICK_TIMEOUT_MS = 5_000;
const DEFAULT_CONFIRM_TIMEOUT_MS = 2_500;

export interface OrchestratorHandeyesOpts {
	eyes: Eyes;
	hands: HandsDriver;
	bus?: OrchestratorBus;
	doomDetector?: DoomLoopDetector;
	scope?: string;
}

class OrchestratorHandeyes implements Handeyes {
	readonly id: string;
	readonly available: boolean;

	private readonly eyes: Eyes;
	private readonly hands: HandsDriver;
	private readonly bus: OrchestratorBus;
	private readonly loop: EngagementLoop;

	constructor(opts: OrchestratorHandeyesOpts) {
		this.eyes = opts.eyes;
		this.hands = opts.hands;
		this.bus = opts.bus ?? getOrchestratorBus();
		this.id = opts.scope ? `orchestrator:${opts.scope}` : "orchestrator";
		this.available = this.eyes.available && this.hands.available;

		const hooks: EngagementLoopHooks = {
			spawnSession: (handle) => this.spawnSession(handle),
		};
		this.loop = new EngagementLoop({
			hooks,
			doomDetector: opts.doomDetector,
		});
	}

	// ---------------------------------------------------------------------
	// Compound actions.
	// ---------------------------------------------------------------------

	async locateAndClick(
		query: LocatorQuery,
		opts: ClickOpts = {},
	): Promise<LocateClickResult> {
		const start = Date.now();
		const retries = Math.max(1, opts.locateRetries ?? DEFAULT_LOCATE_RETRIES);
		const timeoutMs = opts.timeoutMs ?? DEFAULT_CLICK_TIMEOUT_MS;
		const queryKey = canonicalQueryKey(query);

		let attempts = 0;
		let lastHits: Locator[] = [];

		while (attempts < retries) {
			attempts += 1;
			if (Date.now() - start > timeoutMs) {
				return {
					ok: false,
					attempts,
					elapsedMs: Date.now() - start,
					reason: "timeout",
				};
			}
			lastHits = await this.eyes.locate(query);
			const fired = await this.loop.armFindResult(queryKey, lastHits.length);
			if (lastHits.length > 0) break;
			if (fired) {
				return {
					ok: false,
					attempts,
					elapsedMs: Date.now() - start,
					reason: "no_match",
					escalatedTo: fired,
				};
			}
		}

		if (lastHits.length === 0) {
			return {
				ok: false,
				attempts,
				elapsedMs: Date.now() - start,
				reason: "no_match",
			};
		}

		const top = lastHits[0];
		const targetPoint = pickPoint(top);
		if (!targetPoint) {
			return {
				ok: false,
				attempts,
				elapsedMs: Date.now() - start,
				reason: "low_confidence",
			};
		}
		const handsResult = this.hands.click(asHandsPoint(targetPoint), "left", 1);
		if (!handsResult.ok) {
			return {
				ok: false,
				attempts,
				elapsedMs: Date.now() - start,
				reason: "click_dispatch_failed",
				clickedAt: targetPoint,
			};
		}

		if (opts.verifyChanged) {
			const changed = await this.waitForMaterialChange(timeoutMs - (Date.now() - start));
			if (!changed) {
				return {
					ok: false,
					attempts,
					elapsedMs: Date.now() - start,
					reason: "verify_no_change",
					clickedAt: targetPoint,
				};
			}
		}

		return {
			ok: true,
			clickedAt: targetPoint,
			confidence: top.confidence,
			attempts,
			elapsedMs: Date.now() - start,
		};
	}

	async clickAndVerify(
		point: { x: number; y: number },
		expected: Predicate,
		opts: VerifyOpts = {},
	): Promise<VerifyResult> {
		const start = Date.now();
		const maxRetries = Math.max(1, opts.maxRetries ?? DEFAULT_VERIFY_RETRIES);
		const timeoutMs = opts.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;

		let attempts = 0;
		let lastResult: OpResult = { ok: false, error: "no attempt" };

		while (attempts < maxRetries) {
			attempts += 1;
			lastResult = this.hands.click(asHandsPoint(point), "left", 1);
			if (!lastResult.ok) {
				return {
					ok: false,
					attempts,
					elapsedMs: Date.now() - start,
					reason: "predicate_never_true",
				};
			}

			const remaining = timeoutMs - (Date.now() - start);
			if (remaining <= 0) break;
			const wait = await this.eyes.wait_for(expected, { timeoutMs: remaining });
			if (wait.ok) {
				return { ok: true, attempts, elapsedMs: Date.now() - start };
			}
		}

		const result: VerifyResult = {
			ok: false,
			attempts,
			elapsedMs: Date.now() - start,
			reason: "predicate_never_true",
		};
		if (opts.escalateOnFail) {
			const handle = await this.loop.engage("explicit_self_diagnosis");
			result.escalatedTo = handle;
		}
		return result;
	}

	async typeAndConfirm(
		text: string,
		expectedField?: LocatorQuery,
		opts: ConfirmOpts = {},
	): Promise<VerifyResult> {
		const start = Date.now();
		const timeoutMs = opts.timeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;

		const typed = this.hands.type(text);
		if (!typed.ok) {
			return {
				ok: false,
				attempts: 1,
				elapsedMs: Date.now() - start,
				reason: "predicate_never_true",
			};
		}

		if (!expectedField) {
			return { ok: true, attempts: 1, elapsedMs: Date.now() - start };
		}

		const remaining = Math.max(0, timeoutMs - (Date.now() - start));
		const result = await this.eyes.wait_for(
			{ kind: "text_present", text: opts.trimWhitespace ? text.trim() : text },
			{ timeoutMs: remaining },
		);
		return result.ok
			? { ok: true, attempts: 1, elapsedMs: Date.now() - start }
			: {
					ok: false,
					attempts: 1,
					elapsedMs: Date.now() - start,
					reason: "predicate_never_true",
				};
	}

	async engageStruggleMode(
		reason: StruggleReason | string,
		ttlSteps?: number,
	): Promise<StruggleHandle> {
		return this.loop.engage(reason, ttlSteps);
	}

	async exitStruggleMode(handle: StruggleHandle): Promise<void> {
		await this.loop.exitExplicit(handle);
	}

	// ---------------------------------------------------------------------
	// Internals.
	// ---------------------------------------------------------------------

	/**
	 * Spawn the eyes-worker + hands-queue for a session and return a
	 * SessionWorkers with a unified teardown that stops both. The hands
	 * queue is held on the instance so the loop's click-correlation arming
	 * can route through it; the eyes worker publishes diff events the loop
	 * consumes for trigger 3.
	 */
	private async spawnSession(handle: StruggleHandle): Promise<SessionWorkers> {
		const worker = startEyesWorker({
			eyes: this.eyes,
			bus: this.bus,
			sessionId: handle.id,
		});

		const queue: HandsQueue = createHandsQueue({
			eyes: this.eyes,
			hands: this.hands,
			onClick: (key) => {
				this.loop.armClickDispatched(key);
			},
		});

		// Route observe events into the click-without-change detector so
		// trigger 3 fires inside an active session as well.
		const eventName = observationEventName(handle.id);
		const onObs = (event: unknown) => {
			void this.loop.armClickObservation(
				event as Parameters<typeof this.loop.armClickObservation>[0],
			);
		};
		this.bus.on(eventName, onObs);

		return {
			teardown: async () => {
				this.bus.off(eventName, onObs);
				worker.stop();
				await queue.drain();
			},
		};
	}

	/**
	 * Wait briefly for an observe-detected material change. Used by
	 * locateAndClick when verifyChanged is set.
	 */
	private async waitForMaterialChange(maxMs: number): Promise<boolean> {
		const budget = Math.max(0, maxMs);
		if (budget === 0) return false;
		return await new Promise<boolean>((resolve) => {
			let settled = false;
			const disposable = this.eyes.observe((event) => {
				if (settled) return;
				if (event.diff.similarity < 0.95) {
					settled = true;
					try {
						disposable.dispose();
					} catch {}
					resolve(true);
				}
			});
			setTimeout(() => {
				if (settled) return;
				settled = true;
				try {
					disposable.dispose();
				} catch {}
				resolve(false);
			}, budget);
		});
	}

	/** Test hook: expose the loop so tests can drive lifecycle directly. */
	_loopForTests(): EngagementLoop {
		return this.loop;
	}
}

// -------------------------------------------------------------------------
// Adapter registration.
// -------------------------------------------------------------------------

let _factoryDeps: OrchestratorHandeyesOpts | null = null;

/**
 * Wire the dependencies the orchestrator adapter needs. Called once at
 * agent-loop boot (or in tests) before the adapter is selected. Keeps the
 * adapter free of import-time side effects on eyes / hands; both packages
 * have meaningful boot cost (eyes spawns the AX bridge probe; hands
 * fingerprints capabilities) which we do not want paid until the agent
 * actually engages handeyes.
 */
export function configureOrchestratorAdapter(opts: OrchestratorHandeyesOpts): void {
	_factoryDeps = opts;
	// Register on first configure rather than at module load so the cycle
	// between index.ts (which holds the registry) and this module (which is
	// re-exported from index for convenience) cannot dereference an
	// undefined _adapters map under strict ESM evaluation order.
	registerHandeyesAdapter(orchestratorAdapter);
}

export const orchestratorAdapter: HandeyesAdapter = {
	id: "orchestrator",
	available: async () => {
		if (!_factoryDeps) return false;
		return _factoryDeps.eyes.available && _factoryDeps.hands.available;
	},
	create: (opts) => {
		if (!_factoryDeps) {
			throw new Error(
				"handeyes orchestrator adapter: not configured. Call configureOrchestratorAdapter(...) first.",
			);
		}
		return new OrchestratorHandeyes({
			..._factoryDeps,
			scope: opts?.scope ?? _factoryDeps.scope,
		});
	},
};

// Adapter registration happens inside configureOrchestratorAdapter() above.

// -------------------------------------------------------------------------
// Helpers.
// -------------------------------------------------------------------------

function asHandsPoint(p: { x: number; y: number }): HandsPoint {
	return { x: p.x, y: p.y };
}

/**
 * Resolve a Locator to a clickable point. Locator.target is either an id
 * (AX-tree element) or a point. For the point form we use it directly. For
 * the id form we need bbox metadata to compute the centre; if neither is
 * available the locate is treated as low_confidence (no clickable target).
 */
function pickPoint(loc: Locator): Point | null {
	const t = loc.target as { id?: string } & { point?: Point };
	if (t.point && typeof t.point.x === "number" && typeof t.point.y === "number") {
		return { x: t.point.x, y: t.point.y };
	}
	if (loc.bbox) {
		return {
			x: loc.bbox.x + loc.bbox.width / 2,
			y: loc.bbox.y + loc.bbox.height / 2,
		};
	}
	return null;
}

/**
 * Stable key for query-equality checks in the find-zero-hits-twice trigger.
 * Sort keys so cosmetic ordering differences do not register as different
 * queries. Mirrors DoomLoopDetector's stableStringify approach.
 */
function canonicalQueryKey(query: LocatorQuery): string {
	const obj = query as unknown as Record<string, unknown>;
	const sorted = Object.keys(obj)
		.sort()
		.reduce<Record<string, unknown>>((acc, k) => {
			acc[k] = obj[k];
			return acc;
		}, {});
	return JSON.stringify(sorted);
}

// Re-export the impl class for tests that need to drive it directly.
export { OrchestratorHandeyes };
