/**
 * Hands queue - serialises motor calls during a struggle session.
 *
 * Architectural rationale (spec §5.1): there is exactly one mouse pointer.
 * Two motor callers in parallel would clobber each other's pre-click hover
 * state. Outside a struggle session the agent loop is itself sequential and
 * bears its own serialisation responsibility; inside a session, this queue
 * is the explicit "I am the only motor caller right now" guarantee.
 *
 * Race-condition handling (spec §7.1, mid-click animation):
 *   The queue captures a fresh frame at dispatch time and compares it
 *   against the frame the locate ran on. Above the divergence threshold,
 *   the click is held and the locate is re-run once before either
 *   dispatching with the new point or escalating. The actual locate re-run
 *   is delegated to the supplied `relocate` callback because the queue does
 *   not own a LocatorQuery; the caller (handeyes-impl) does.
 */

import type {
	AnnotatedFrame,
	Eyes,
	Frame,
	Point,
} from "@8gent/eyes";
import type { HandsDriver, MouseButton, OpResult } from "@8gent/hands";

/** v0 mid-click similarity threshold per spec §7.1. */
export const MID_CLICK_SIMILARITY_THRESHOLD = 0.95;

/** v0 mid-click hold timeout per spec §7.1. */
export const MID_CLICK_HOLD_MS = 300;

export interface HandsQueueOpts {
	hands: HandsDriver;
	eyes: Eyes;
	/**
	 * Called when the dispatch-time frame diverges from the locate-time
	 * frame above the threshold. Implementations re-run the original
	 * LocatorQuery and return the fresh point (or null on no_match).
	 * Returning a Point keeps the Locator.target {id|point} discriminated
	 * union out of the queue's contract; resolution to a clickable point is
	 * the caller's job, mirroring how locateAndClick already handles it.
	 */
	relocate?: (originalPoint: Point) => Promise<Point | null>;
	/** Optional hook fired after every dispatched click. */
	onClick?: (key: string, point: Point, result: OpResult) => void;
	/** Override hold timeout for tests. */
	holdMs?: number;
	/** Override divergence threshold for tests. */
	threshold?: number;
}

export interface QueuedClick {
	point: Point;
	button?: MouseButton;
	count?: number;
	/** Frame the locate ran on, used for mid-click divergence check. */
	locateFrame?: Frame | AnnotatedFrame;
	/**
	 * Caller-supplied identifier so observers can correlate this click with
	 * subsequent observe events. Typically the StruggleHandle id + a step
	 * counter.
	 */
	key: string;
}

export type ClickOutcome =
	| { ok: true; result: OpResult; clickedAt: Point; relocated: boolean }
	| { ok: false; reason: "no_match" | "dispatch_failed"; result?: OpResult };

export interface QueuedType {
	text: string;
	delayMs?: number;
	key: string;
}

export interface HandsQueue {
	enqueueClick(req: QueuedClick): Promise<ClickOutcome>;
	enqueueType(req: QueuedType): Promise<OpResult>;
	/**
	 * Stop accepting new work and resolve when the in-flight call (if any)
	 * settles. Idempotent.
	 */
	drain(): Promise<void>;
	readonly draining: boolean;
}

export function createHandsQueue(opts: HandsQueueOpts): HandsQueue {
	const threshold = opts.threshold ?? MID_CLICK_SIMILARITY_THRESHOLD;
	let inflight: Promise<unknown> = Promise.resolve();
	let draining = false;

	async function midClickCheck(req: QueuedClick): Promise<Point | null> {
		if (!req.locateFrame || !opts.relocate) return req.point;
		try {
			const fresh = await opts.eyes.capture({
				displayId: req.locateFrame.displayId,
			});
			const diff = await opts.eyes.diff(req.locateFrame as Frame, fresh);
			if (diff.similarity >= threshold) return req.point;
			// Divergence above threshold: re-run the locate once.
			const fresher = await opts.relocate(req.point);
			if (!fresher) return null;
			return fresher;
		} catch {
			// Capture or diff failure falls back to the original point.
			// The action is more useful than the safety net here.
			return req.point;
		}
	}

	async function runClick(req: QueuedClick): Promise<ClickOutcome> {
		const point = await midClickCheck(req);
		if (!point) return { ok: false, reason: "no_match" };
		const relocated = point.x !== req.point.x || point.y !== req.point.y;
		const result = opts.hands.click(point, req.button ?? "left", req.count ?? 1);
		opts.onClick?.(req.key, point, result);
		if (!result.ok) {
			return { ok: false, reason: "dispatch_failed", result };
		}
		return { ok: true, result, clickedAt: point, relocated };
	}

	function enqueue<T>(work: () => Promise<T>): Promise<T> {
		if (draining) {
			return Promise.reject(new Error("hands-queue: drained"));
		}
		const next = inflight.then(work, work);
		// Swallow rejections in the chain so one failure does not poison the
		// whole queue. Each caller observes its own outcome via the returned
		// promise.
		inflight = next.catch(() => undefined);
		return next;
	}

	return {
		get draining() {
			return draining;
		},
		enqueueClick(req) {
			return enqueue(() => runClick(req));
		},
		enqueueType(req) {
			return enqueue(async () => opts.hands.type(req.text, req.delayMs));
		},
		async drain() {
			draining = true;
			try {
				await inflight;
			} catch {
				// Swallow: drain only cares that the chain settled.
			}
		},
	};
}
