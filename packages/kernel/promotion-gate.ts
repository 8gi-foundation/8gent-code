/**
 * Promotion Gate (P0-2) - the hard safety item.
 *
 * Today the kernel auto-promotes a freshly trained model into the router on a
 * single cloud-judge verdict, validating against the SAME benchmark family it
 * trained on (train-on-test), with a best-effort shell rollback that no-ops if
 * the external binary is absent. That is the landmine this gate disarms.
 *
 * No model is promoted unless ALL of these hold, in order:
 *   1. Frozen hold-out beat: candidate must beat (or tie) the active model on a
 *      SEALED eval set that training never saw. Regress on ANY hold-out task ->
 *      reject. (Stops train-on-test.)
 *   2. Canary: route a small % (default 5) of live turns to the candidate for N
 *      turns; auto-demote on error-rate or score regression vs active.
 *   3. Human confirm for minor+: patch MAY auto-proceed inside canary bounds;
 *      minor or major REQUIRES an explicit human confirm token. Major is never
 *      auto-promoted.
 *   4. Rollback manifest: a real `~/.8gent/promotion-policy.json` recording
 *      {activeVersion, previousVersion, weightsPath, baselineSnapshot} written
 *      BEFORE any swap, so rollback restores from the manifest, not a shell call.
 *
 * Auto-promote autonomy = Level 0: human confirm on EVERY promotion by default.
 * `autoPromote` defaults to FALSE everywhere. This module is the single source
 * of truth for that default and the gate logic.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PROMOTION_POLICY_PATH = join(homedir(), ".8gent", "promotion-policy.json");

/** SemVer-style bump class for a candidate. */
export type BumpClass = "patch" | "minor" | "major" | "none";

/**
 * Promotion autonomy levels.
 *   0 = human confirm on EVERY promotion (default, adopted)
 *   1 = patch may auto-promote inside canary bounds; minor+ needs human
 *   2 = (reserved) wider auto-promotion - NOT a default, never auto-selected
 */
export type PromotionAutonomy = 0 | 1 | 2;

export interface PromotionPolicy {
	/** Master switch. DEFAULT FALSE. Nothing promotes unless this is true. */
	autoPromote: boolean;
	/** Autonomy level. DEFAULT 0 (human-confirm every promotion). */
	autonomy: PromotionAutonomy;
	/** Canary traffic fraction (0..1). DEFAULT 0.05 (5%). */
	canaryFraction: number;
	/** Number of canary turns before a candidate may graduate. DEFAULT 50. */
	canaryMinTurns: number;
	/** Max acceptable canary error rate (0..1) before auto-demote. DEFAULT 0.02. */
	canaryMaxErrorRate: number;
	/** Path to the sealed hold-out eval set (JSON). Never written by training. */
	holdOutPath: string;
}

export const DEFAULT_PROMOTION_POLICY: PromotionPolicy = {
	autoPromote: false, // P0-2: the landmine, defused. NEVER default true.
	autonomy: 0, // Level 0: human-confirm every promotion.
	canaryFraction: 0.05,
	canaryMinTurns: 50,
	canaryMaxErrorRate: 0.02,
	holdOutPath: join(homedir(), ".8gent", "kernel", "holdout.json"),
};

/** A sealed hold-out: per-task target scores the candidate must not regress. */
export interface HoldOut {
	/** taskId -> active model's score on that task (the bar to beat or tie). */
	tasks: Record<string, number>;
	sealedAt: string;
}

/** Per-task candidate scores measured on the frozen hold-out. */
export interface HoldOutResult {
	tasks: Record<string, number>;
}

export interface CanarySignal {
	turns: number;
	errors: number;
	/** Candidate avg score over canary turns. */
	candidateAvgScore: number;
	/** Active avg score over the same window. */
	activeAvgScore: number;
}

/** A human-signed confirmation that a promotion may proceed. */
export interface HumanConfirm {
	/** True only if a human approved this exact candidate. */
	approved: boolean;
	candidateId: string;
}

export interface PromotionRequest {
	candidateId: string;
	bump: BumpClass;
	holdOut: HoldOut;
	holdOutResult: HoldOutResult;
	canary?: CanarySignal;
	humanConfirm?: HumanConfirm;
}

export interface PromotionDecision {
	promote: boolean;
	reason: string;
	/** Which gate blocked, when promote=false. */
	blockedBy?: "disabled" | "holdout" | "canary" | "human-confirm";
}

/** Rollback manifest written before any swap. */
export interface RollbackManifest {
	activeVersion: string;
	previousVersion: string;
	weightsPath: string;
	baselineSnapshot: Record<string, number>;
	writtenAt: string;
}

export function loadPromotionPolicy(path: string = PROMOTION_POLICY_PATH): PromotionPolicy {
	try {
		if (existsSync(path)) {
			const raw = JSON.parse(readFileSync(path, "utf-8"));
			// Merge over defaults so a partial file can never silently flip
			// autoPromote on; the field must be explicitly true in the file.
			return { ...DEFAULT_PROMOTION_POLICY, ...raw };
		}
	} catch {
		// Unreadable policy = fail CLOSED to the safe default (no auto-promote).
	}
	return { ...DEFAULT_PROMOTION_POLICY };
}

/**
 * Frozen hold-out check: candidate must beat-or-tie the active model on EVERY
 * sealed task. Any regression on any task rejects. A task present in the
 * hold-out but missing from the candidate result counts as a regression
 * (we cannot prove it did not regress).
 */
export function holdOutBeats(
	holdOut: HoldOut,
	result: HoldOutResult,
): { ok: boolean; reason: string } {
	const taskIds = Object.keys(holdOut.tasks);
	if (taskIds.length === 0) {
		return { ok: false, reason: "hold-out is empty; cannot certify no regression" };
	}
	for (const id of taskIds) {
		const bar = holdOut.tasks[id];
		const got = result.tasks[id];
		if (got === undefined) {
			return { ok: false, reason: `hold-out task '${id}' not evaluated on candidate` };
		}
		if (got < bar) {
			return { ok: false, reason: `hold-out regression on '${id}': ${got} < ${bar}` };
		}
	}
	return { ok: true, reason: `candidate beat-or-tied all ${taskIds.length} hold-out tasks` };
}

function canaryHealthy(
	canary: CanarySignal,
	policy: PromotionPolicy,
): { ok: boolean; reason: string } {
	if (canary.turns < policy.canaryMinTurns) {
		return {
			ok: false,
			reason: `canary incomplete: ${canary.turns}/${policy.canaryMinTurns} turns`,
		};
	}
	const errorRate = canary.turns > 0 ? canary.errors / canary.turns : 1;
	if (errorRate > policy.canaryMaxErrorRate) {
		return {
			ok: false,
			reason: `canary error rate ${(errorRate * 100).toFixed(1)}% exceeds ${(policy.canaryMaxErrorRate * 100).toFixed(1)}%`,
		};
	}
	if (canary.candidateAvgScore < canary.activeAvgScore) {
		return {
			ok: false,
			reason: `canary score regression: candidate ${canary.candidateAvgScore} < active ${canary.activeAvgScore}`,
		};
	}
	return { ok: true, reason: "canary healthy" };
}

/**
 * The single decision function. Returns promote=true ONLY when every gate
 * passes. Pure - no I/O - so it is exhaustively testable.
 */
export function evaluatePromotion(
	req: PromotionRequest,
	policy: PromotionPolicy = DEFAULT_PROMOTION_POLICY,
): PromotionDecision {
	// Gate 0: master switch. Default false -> nothing promotes.
	if (!policy.autoPromote) {
		return {
			promote: false,
			reason:
				"autoPromote is disabled (default). No model promotes without an explicit policy opt-in.",
			blockedBy: "disabled",
		};
	}

	// Gate 1: frozen hold-out. Train-on-test is rejected here.
	const ho = holdOutBeats(req.holdOut, req.holdOutResult);
	if (!ho.ok) {
		return { promote: false, reason: ho.reason, blockedBy: "holdout" };
	}

	// Gate 2: canary. Required for every promotion class.
	if (!req.canary) {
		return { promote: false, reason: "no canary signal provided", blockedBy: "canary" };
	}
	const can = canaryHealthy(req.canary, policy);
	if (!can.ok) {
		return { promote: false, reason: can.reason, blockedBy: "canary" };
	}

	// Gate 3: human confirm.
	// - major: ALWAYS requires human confirm, never auto.
	// - minor: requires human confirm unless... it always requires it (minor+).
	// - patch: may auto-proceed ONLY at autonomy level >= 1 AND inside canary.
	//   At autonomy level 0 (default), even a patch needs human confirm.
	const confirmed =
		req.humanConfirm?.approved === true && req.humanConfirm.candidateId === req.candidateId;

	if (req.bump === "major") {
		// Major is irreversible-class: human confirm mandatory, no autonomy lifts it.
		if (!confirmed) {
			return {
				promote: false,
				reason: "major promotion always requires human confirm",
				blockedBy: "human-confirm",
			};
		}
		return { promote: true, reason: "all gates passed (major, human-confirmed)" };
	}

	if (req.bump === "minor") {
		if (!confirmed) {
			return {
				promote: false,
				reason: "minor promotion requires human confirm (minor+)",
				blockedBy: "human-confirm",
			};
		}
		return { promote: true, reason: "all gates passed (minor, human-confirmed)" };
	}

	// patch (or "none" treated as patch-ish): autonomy gate.
	if (policy.autonomy >= 1 && confirmed === false) {
		// Level 1+: patch may auto-proceed inside canary bounds without a fresh
		// human token, because the canary already gated it.
		return { promote: true, reason: "patch auto-promoted inside canary bounds (autonomy >= 1)" };
	}
	if (confirmed) {
		return { promote: true, reason: "all gates passed (patch, human-confirmed)" };
	}
	return {
		promote: false,
		reason: "patch promotion requires human confirm at autonomy level 0 (default)",
		blockedBy: "human-confirm",
	};
}

/**
 * Write the rollback manifest BEFORE any router swap. Returns the path written.
 */
export function writeRollbackManifest(
	manifest: Omit<RollbackManifest, "writtenAt">,
	path: string = PROMOTION_POLICY_PATH,
): string {
	const full: RollbackManifest = { ...manifest, writtenAt: new Date().toISOString() };
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	// The promotion-policy.json file carries BOTH the policy and the current
	// rollback manifest under `rollback`, so rollback() reads from disk truth.
	let existing: Record<string, unknown> = {};
	try {
		if (existsSync(path)) existing = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		existing = {};
	}
	existing.rollback = full;
	writeFileSync(path, JSON.stringify(existing, null, 2));
	return path;
}

/**
 * Read the rollback manifest. Returns null when none is recorded.
 */
export function readRollbackManifest(
	path: string = PROMOTION_POLICY_PATH,
): RollbackManifest | null {
	try {
		if (!existsSync(path)) return null;
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return (raw.rollback as RollbackManifest) ?? null;
	} catch {
		return null;
	}
}
