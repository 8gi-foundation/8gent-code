/**
 * @8gent/handeyes - shared types for the sensorimotor coordination contract.
 *
 * Spec: docs/specs/HANDEYES-SPEC.md
 *
 * These types reference Predicate, LocatorQuery, Locator, Frame, Region, and
 * Point from @8gent/eyes. We re-export the subset that handeyes consumers
 * need so callers do not have to import from both packages just to type a
 * single call.
 *
 * NOTE: this file is the contract surface only. No coordination logic lives
 * here; the engagement loop, eyes-worker spawning, and hands-queue
 * serialisation land in a follow-up PR per the issue scope (#2526).
 */

import type {
	LocatorQuery,
	Point,
	Predicate,
	Region,
} from "@8gent/eyes/types";

// Re-export the eyes types handeyes consumers need so they can import a
// single surface. Keeps cross-package dependencies legible.
export type { LocatorQuery, Point, Predicate, Region } from "@8gent/eyes/types";

// ---------------------------------------------------------------------------
// Click / verify / confirm option bags.
//
// The defaults are deliberately loose at the contract layer. Backends pin
// concrete numbers; the spec records the v0 defaults (see §4 and §6).
// ---------------------------------------------------------------------------

export interface ClickOpts {
	/** Mouse button. Default: "left". */
	button?: "left" | "right" | "middle";
	/** Modifier keys held during the click. */
	modifiers?: Array<"cmd" | "ctrl" | "alt" | "shift">;
	/**
	 * Maximum locate retries before giving up. Default: 1 (no retry). Set
	 * higher to engage struggle mode automatically when the first locate
	 * misses; see spec §4 trigger heuristic 1.
	 */
	locateRetries?: number;
	/**
	 * If true, the call will block until the screen registers a material
	 * change after the click (per ObserveOpts.thresholdSimilarity in eyes).
	 * Default: false at contract level; compound tools may flip this on.
	 */
	verifyChanged?: boolean;
	/** Timeout for the whole locate -> click -> (optional) verify path, ms. */
	timeoutMs?: number;
}

export interface VerifyOpts {
	/** How long to wait for the predicate to become true after the action, ms. */
	timeoutMs?: number;
	/** Maximum number of retry cycles before declaring failure. Default: 2. */
	maxRetries?: number;
	/**
	 * If true and the predicate never becomes true, escalate by engaging
	 * struggle mode and surfacing the failure to the agent loop instead of
	 * silently returning ok:false. Default: false.
	 */
	escalateOnFail?: boolean;
}

export interface ConfirmOpts {
	/** Field to look at when confirming the typed text landed. */
	timeoutMs?: number;
	/** Allow whitespace-only differences between expected and observed. */
	trimWhitespace?: boolean;
	/** Case-insensitive comparison. Default: false. */
	caseInsensitive?: boolean;
}

// ---------------------------------------------------------------------------
// Result types.
//
// All compound calls return a discriminated `ok` boolean plus a structured
// reason. Throwing is reserved for programmer errors (bad arg shape); user-
// or environment-driven failure modes are values.
// ---------------------------------------------------------------------------

export interface LocateClickResult {
	ok: boolean;
	/** The point the click was actually dispatched to, if any. */
	clickedAt?: Point;
	/** Confidence of the locator that produced the click target, 0..1. */
	confidence?: number;
	/** Number of locate attempts before success or final failure. */
	attempts: number;
	/** Wall-clock time spent inside the call, ms. */
	elapsedMs: number;
	/** Why the call failed, if it did. Empty when ok=true. */
	reason?:
		| "no_match"
		| "low_confidence"
		| "click_dispatch_failed"
		| "verify_no_change"
		| "timeout"
		| "permission_denied";
	/** If escalation fired, the handle of the resulting struggle session. */
	escalatedTo?: StruggleHandle;
}

export interface VerifyResult {
	ok: boolean;
	attempts: number;
	elapsedMs: number;
	reason?: "predicate_never_true" | "timeout" | "permission_denied";
	escalatedTo?: StruggleHandle;
}

// ---------------------------------------------------------------------------
// Struggle mode.
//
// Struggle mode is the explicit, transient engagement of the eyes-worker +
// hands-queue + coordinator triad. It is bounded by step count and exits
// automatically when forward progress resumes (see spec §4).
// ---------------------------------------------------------------------------

export interface StruggleHandle {
	/** Opaque session id, scoped to one engagement. */
	id: string;
	/** Wall-clock the engagement started. */
	startedAt: number;
	/** The trigger that fired; useful for trace queries. */
	reason: StruggleReason;
	/** Steps remaining before auto-exit. Decremented by the coordinator. */
	ttlSteps: number;
}

export type StruggleReason =
	| "explicit_self_diagnosis"
	| "find_zero_hits_repeated"
	| "wait_for_timeout"
	| "click_no_observable_change"
	| "doom_loop_detected";

// Used internally by the spec but useful at the contract layer for testing
// trigger heuristics without spinning up the full coordinator.
export interface StruggleTriggerInput {
	reason: StruggleReason;
	/** Free-form context the trigger source can attach. */
	context?: Record<string, unknown>;
}
