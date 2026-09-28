/**
 * Per-model calibration for the locate mode question (Jev level 4 gate).
 *
 * locate asks System One one `choice` question about a prose query: which of
 * symbol, grep, path, semantic or hybrid retrieval should answer it. The
 * model only reports probabilities. Code keeps the model's mode when its
 * probability (the choice confidence) is at or above a per-(backend, model)
 * threshold, and falls back to hybrid otherwise. Hybrid is always a safe
 * answer: it searches symbols, text and paths together, which is what locate
 * did before the model existed.
 *
 * The threshold is fitted on a labelled eval result
 * (eval/locate-prose-run.ts): the cut that maximises gated accuracy (gated
 * mode equals the hand label), ties going to the higher cut so that more
 * queries stay on hybrid. Held-out numbers come from leave-one-out. A missing
 * or malformed file means the model is uncalibrated, and locate then gates it
 * at LOCATE_DEFAULT_THRESHOLD (ast-index/locate-system-one.ts).
 *
 * Kept apart from calibrate.ts (the bash guard's Platt scaling): a routing
 * choice has no fail-closed side and needs one cut, not a band. Same file
 * naming, under calibration/locate/.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CALIBRATION_DIR, calibrationFileName, rate } from "./calibrate";
import { DecideError } from "./types";

/** The options of the locate mode question, in the order they are asked. */
export const LOCATE_MODES = ["symbol", "grep", "path", "semantic", "hybrid"] as const;
export type LocateModeChoice = (typeof LOCATE_MODES)[number];
/** What an unsure or failed answer becomes. */
export const LOCATE_FALLBACK_MODE: LocateModeChoice = "hybrid";
export const LOCATE_CALIBRATION_DIR = path.join(CALIBRATION_DIR, "locate");

export interface LocateSample {
	/** The model's most probable mode. */
	chosen: LocateModeChoice;
	/** Its probability. */
	confidence: number;
	/** Hand label. */
	label: LocateModeChoice;
}

export interface LocateHeldOut {
	/** Gated mode equals the label. */
	accuracy: number;
	/** Share of queries where the model's mode was kept. */
	coverage: number;
	/** Accuracy over the kept queries only. NaN when none was kept. */
	acceptedAccuracy: number;
	method: "leave-one-out";
}

export interface LocateCalibration {
	kind: "locate-mode";
	model: string;
	backend: string;
	/** Keep the model's mode when its confidence is >= this. In [0, 1]. */
	threshold: number;
	/** Eval result file the fit was made from, relative to packages/decide. */
	fittedOn: string;
	n: number;
	/** Ungated: the model's argmax equals the label. */
	rawAccuracy: number;
	heldOut: LocateHeldOut;
	note?: string;
}

function isMode(x: unknown): x is LocateModeChoice {
	return typeof x === "string" && (LOCATE_MODES as readonly string[]).includes(x);
}

/**
 * The mode locate uses: the model's mode when `confidence >= threshold`,
 * else hybrid. Anything non-finite, out of [0, 1] or unknown is hybrid.
 */
export function gateMode(
	chosen: LocateModeChoice,
	confidence: number,
	threshold: number,
): LocateModeChoice {
	if (!isMode(chosen)) return LOCATE_FALLBACK_MODE;
	if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return LOCATE_FALLBACK_MODE;
	if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) return LOCATE_FALLBACK_MODE;
	return confidence >= threshold ? chosen : LOCATE_FALLBACK_MODE;
}

function gatedCorrect(samples: LocateSample[], t: number): number {
	let n = 0;
	for (const x of samples) if (gateMode(x.chosen, x.confidence, t) === x.label) n++;
	return n;
}

/**
 * The cut that maximises gated accuracy on `samples`. Candidates are every
 * observed confidence plus 1 (keep hybrid unless the model is certain). A tie
 * goes to the higher cut. Deterministic.
 */
export function fitLocateThreshold(samples: LocateSample[]): number {
	if (samples.length === 0) throw new DecideError("locate calibration needs at least one sample");
	const candidates = [
		...new Set([
			...samples.map((x) => x.confidence).filter((c) => Number.isFinite(c) && c >= 0 && c <= 1),
			1,
		]),
	].sort((a, b) => a - b);
	let best = 1;
	let bestScore = -1;
	for (const t of candidates) {
		const score = gatedCorrect(samples, t);
		if (score >= bestScore) {
			best = t;
			bestScore = score;
		}
	}
	return best;
}

export interface LocateHeldOutRow {
	threshold: number;
	gated: LocateModeChoice;
	/** The model's mode was kept. */
	accepted: boolean;
}

function summarise(samples: LocateSample[], rows: LocateHeldOutRow[]): LocateHeldOut {
	const accepted = rows.map((r, i) => ({ r, x: samples[i] })).filter(({ r }) => r.accepted);
	return {
		accuracy: rate(rows.filter((r, i) => r.gated === samples[i].label).length, rows.length),
		coverage: rate(accepted.length, rows.length),
		acceptedAccuracy: rate(
			accepted.filter(({ r, x }) => r.gated === x.label).length,
			accepted.length,
		),
		method: "leave-one-out",
	};
}

/** Leave-one-out: each sample is gated by a threshold fitted on the other n - 1. */
export function locateLeaveOneOut(samples: LocateSample[]): {
	rows: LocateHeldOutRow[];
	heldOut: LocateHeldOut;
} {
	const rows = samples.map((x, i) => {
		const threshold = fitLocateThreshold(samples.filter((_, j) => j !== i));
		const gated = gateMode(x.chosen, x.confidence, threshold);
		return {
			threshold,
			gated,
			accepted: Number.isFinite(x.confidence) && x.confidence >= threshold && isMode(x.chosen),
		};
	});
	return { rows, heldOut: summarise(samples, rows) };
}

/** Threshold on all samples, raw accuracy, and leave-one-out held-out numbers. */
export function fitLocateCalibration(samples: LocateSample[]): {
	threshold: number;
	rawAccuracy: number;
	heldOut: LocateHeldOut;
} {
	return {
		threshold: fitLocateThreshold(samples),
		rawAccuracy: rate(samples.filter((x) => x.chosen === x.label).length, samples.length),
		heldOut: locateLeaveOneOut(samples).heldOut,
	};
}

function isLocateCalibration(x: unknown): x is LocateCalibration {
	if (!x || typeof x !== "object" || Array.isArray(x)) return false;
	const c = x as LocateCalibration;
	return (
		c.kind === "locate-mode" &&
		typeof c.model === "string" &&
		typeof c.backend === "string" &&
		typeof c.threshold === "number" &&
		Number.isFinite(c.threshold) &&
		c.threshold >= 0 &&
		c.threshold <= 1 &&
		!!c.heldOut &&
		typeof c.heldOut === "object" &&
		typeof c.heldOut.accuracy === "number" &&
		Number.isFinite(c.heldOut.accuracy)
	);
}

/**
 * Read calibration/locate/<backend>-<model-slug>.json. Null when absent,
 * malformed, or fitted for another (backend, model): the caller uses its default threshold.
 */
export function loadLocateCalibration(
	model: string,
	backend: string,
	dir = LOCATE_CALIBRATION_DIR,
): LocateCalibration | null {
	try {
		const parsed: unknown = JSON.parse(
			fs.readFileSync(path.join(dir, calibrationFileName(backend, model)), "utf8"),
		);
		return isLocateCalibration(parsed) && parsed.model === model && parsed.backend === backend
			? parsed
			: null;
	} catch {
		return null;
	}
}
