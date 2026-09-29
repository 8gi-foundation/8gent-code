/**
 * Per-model calibration for the bash guard (M2 seed).
 *
 * Some models separate destructive from safe commands almost perfectly
 * (AUC 0.99-1.0) but never put a destructive command above the default 0.5
 * block threshold. Calibration fixes that in code, per model:
 *
 *   1. Platt / temperature scaling of pYes, fitted on the logit:
 *        calibrated = sigmoid(logit(pYes) / temperature + bias)
 *      Fitted by plain gradient descent (no deps) on cross-entropy with
 *      Platt's smoothed targets, which keeps the fit finite when the classes
 *      are perfectly separable.
 *   2. Thresholds on the calibrated value: an allow floor just under the
 *      lowest destructive score (catch 100% of the training destructive set)
 *      and a block line just over the highest safe score (0 training safe
 *      false-blocks). Everything between the two escalates.
 *
 * The verdict semantics match guard.ts exactly: inside `escalateBand`
 * (inclusive) is "escalate", above `blockAbove` is "block", else "allow",
 * and any non-finite probability is "block" (fail closed).
 *
 * Everything here is pure. Adoption by guard.ts / probe.ts is a follow-up:
 * either call `calibratedVerdict`, or pass `toRawGuardOptions(cal)` straight
 * into `bashGuard` today (calibration is monotone, so thresholds map back to
 * raw pYes exactly).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { BashGuardOptions } from "./guard";
import { DecideError } from "./types";

/** pYes is clamped to [P_EPS, 1 - P_EPS] before the logit. Eval rows are stored to 4 decimals, so 0 means "under 0.00005". */
export const P_EPS = 1e-4;
/** Margin, in calibrated log-odds, added outside the training extremes. Chosen before looking at held-out results; not tuned. */
export const DEFAULT_MARGIN = 1;
export const DEFAULT_STEPS = 500;
export const DEFAULT_LEARNING_RATE = 0.5;

export const CALIBRATION_DIR = path.join(import.meta.dir, "calibration");

export interface Sample {
	/** Raw model pYes. */
	p: number;
	/** True label: the command is destructive. */
	destructive: boolean;
}

export interface Scaling {
	/** calibrated = sigmoid(logit(p) / temperature + bias). Always > 0. */
	temperature: number;
	bias: number;
}

export interface Thresholds {
	/** Block when calibrated pYes is above this. Equals escalateBand[1]. */
	blockAbove: number;
	/** Inclusive [low, high] band of calibrated pYes that escalates. Below low allows. */
	escalateBand: [number, number];
}

export type Fit = Scaling & Thresholds;

export interface HeldOut {
	/** Destructive commands not allowed (block or escalate), held out. */
	recall: number;
	/** Safe commands blocked, held out. */
	falseBlock: number;
	/** Calibrated pYes > 0.5 matches the label, held out (same definition as eval/run.ts). */
	accuracy: number;
	/** All commands escalated, held out. */
	escalate: number;
	method: "leave-one-out";
}

export interface Calibration extends Fit {
	model: string;
	/**
	 * Backend the eval ran on ("ollama", "llamacpp", ...). The same model can
	 * score differently through a different runtime, so calibration is keyed
	 * on (backend, model) and never shared across backends.
	 */
	backend: string;
	/** Eval result file(s) the fit was made from. */
	fittedOn: string;
	n: number;
	heldOut: HeldOut;
	note?: string;
}

export type Verdict = "allow" | "block" | "escalate";

export function sigmoid(z: number): number {
	if (z >= 0) return 1 / (1 + Math.exp(-z));
	const e = Math.exp(z);
	return e / (1 + e);
}

export function logit(p: number): number {
	const q = Math.min(1 - P_EPS, Math.max(P_EPS, p));
	return Math.log(q / (1 - q));
}

/** Calibrated log-odds. NaN in, NaN out. */
export function calibratedLogit(p: number, s: Scaling): number {
	if (!Number.isFinite(p)) return Number.NaN;
	return logit(p) / s.temperature + s.bias;
}

/** Calibrated pYes. NaN in, NaN out (so a guard fails closed). */
export function applyCalibration(p: number, s: Scaling): number {
	return sigmoid(calibratedLogit(p, s));
}

/**
 * Fit temperature and bias by gradient descent on mean cross-entropy against
 * Platt's targets (N+ + 1) / (N+ + 2) and 1 / (N- + 2). The logit feature is
 * standardised for conditioning, then the weights are mapped back.
 * Deterministic: fixed init, fixed steps, full batch.
 */
export function fitScaling(samples: Sample[], opts: { steps?: number; lr?: number } = {}): Scaling {
	const steps = opts.steps ?? DEFAULT_STEPS;
	const lr = opts.lr ?? DEFAULT_LEARNING_RATE;
	const pos = samples.filter((s) => s.destructive).length;
	const neg = samples.length - pos;
	if (pos === 0 || neg === 0) throw new DecideError("calibration needs at least one destructive and one safe sample");
	const tPos = (pos + 1) / (pos + 2);
	const tNeg = 1 / (neg + 2);
	const xs = samples.map((s) => logit(s.p));
	const ts = samples.map((s) => (s.destructive ? tPos : tNeg));
	const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
	const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mu) ** 2, 0) / xs.length) || 1;
	const zs = xs.map((x) => (x - mu) / sd);
	let w = 1;
	let b = 0;
	for (let i = 0; i < steps; i++) {
		let gw = 0;
		let gb = 0;
		for (let j = 0; j < zs.length; j++) {
			const err = sigmoid(w * zs[j] + b) - ts[j];
			gw += err * zs[j];
			gb += err;
		}
		w -= (lr * gw) / zs.length;
		b -= (lr * gb) / zs.length;
	}
	const slope = w / sd;
	if (!(slope > 0)) throw new DecideError(`calibration found no positive signal (slope ${slope})`);
	return { temperature: 1 / slope, bias: b - slope * mu };
}

/**
 * Thresholds from calibrated log-odds of a training set.
 *   low  = lowest destructive - margin  (allow only below this)
 *   high = highest safe + margin        (block only above this)
 * If the classes are separated by more than 2 * margin, the band collapses
 * to the midpoint of the gap: one cut, nothing escalates.
 */
export function fitThresholds(samples: Sample[], s: Scaling, margin = DEFAULT_MARGIN): Thresholds {
	let dMin = Number.POSITIVE_INFINITY;
	let sMax = Number.NEGATIVE_INFINITY;
	for (const x of samples) {
		const z = calibratedLogit(x.p, s);
		if (x.destructive) dMin = Math.min(dMin, z);
		else sMax = Math.max(sMax, z);
	}
	if (!Number.isFinite(dMin) || !Number.isFinite(sMax)) {
		throw new DecideError("thresholds need at least one destructive and one safe sample");
	}
	let low = dMin - margin;
	let high = sMax + margin;
	if (low > high) {
		const mid = (dMin + sMax) / 2;
		low = mid;
		high = mid;
	}
	const band: [number, number] = [sigmoid(low), sigmoid(high)];
	return { blockAbove: band[1], escalateBand: band };
}

export function fitCalibration(samples: Sample[], opts: { margin?: number; steps?: number; lr?: number } = {}): Fit {
	const scaling = fitScaling(samples, opts);
	return { ...scaling, ...fitThresholds(samples, scaling, opts.margin) };
}

/** Same rule as guard.ts, applied to an already-calibrated probability. */
export function verdictFor(q: number, t: Thresholds): Verdict {
	if (!Number.isFinite(q) || q < 0 || q > 1) return "block";
	const [low, high] = t.escalateBand;
	if (q >= low && q <= high) return "escalate";
	if (q > t.blockAbove) return "block";
	return "allow";
}

/** The function guard.ts can adopt: raw pYes in, calibrated verdict out. */
export function calibratedVerdict(pYes: number, fit: Fit): Verdict {
	return verdictFor(applyCalibration(pYes, fit), fit);
}

/** Inverse of applyCalibration, clamped to the same [P_EPS, 1 - P_EPS] range. */
export function rawFromCalibrated(q: number, s: Scaling): number {
	const z = Math.log(q / (1 - q));
	return Math.min(1 - P_EPS, Math.max(P_EPS, sigmoid((z - s.bias) * s.temperature)));
}

/**
 * Thresholds mapped back to raw pYes, so `bashGuard(cmd, decider,
 * toRawGuardOptions(cal))` gives the calibrated verdict with no guard change.
 * Exact because calibration is strictly increasing.
 */
export function toRawGuardOptions(fit: Fit): Required<BashGuardOptions> {
	const low = rawFromCalibrated(fit.escalateBand[0], fit);
	const high = rawFromCalibrated(fit.escalateBand[1], fit);
	return { blockAbove: high, escalateBand: [low, high] };
}

export function rate(num: number, den: number): number {
	return den === 0 ? Number.NaN : num / den;
}

export interface HeldOutRow extends Sample {
	/** Calibrated pYes from a fit that never saw this sample. */
	q: number;
	verdict: Verdict;
}

/**
 * Leave-one-out: for each sample, fit scaling and thresholds on the other
 * n - 1, then score the held-out one. Returns one held-out row per sample.
 */
export function leaveOneOutRows(samples: Sample[], opts: { margin?: number; steps?: number; lr?: number } = {}): HeldOutRow[] {
	return samples.map((x, i) => {
		const fit = fitCalibration(
			samples.filter((_, j) => j !== i),
			opts,
		);
		const q = applyCalibration(x.p, fit);
		return { ...x, q, verdict: verdictFor(q, fit) };
	});
}

/** Held-out metrics from leave-one-out. Only held-out verdicts are counted. */
export function leaveOneOut(samples: Sample[], opts: { margin?: number; steps?: number; lr?: number } = {}): HeldOut {
	return summariseHeldOut(leaveOneOutRows(samples, opts));
}

export function summariseHeldOut(rows: HeldOutRow[]): HeldOut {
	const destr = rows.filter((r) => r.destructive);
	const safe = rows.filter((r) => !r.destructive);
	return {
		recall: rate(destr.filter((r) => r.verdict !== "allow").length, destr.length),
		falseBlock: rate(safe.filter((r) => r.verdict === "block").length, safe.length),
		accuracy: rate(rows.filter((r) => r.q > 0.5 === r.destructive).length, rows.length),
		escalate: rate(rows.filter((r) => r.verdict === "escalate").length, rows.length),
		method: "leave-one-out",
	};
}

/** Same slug rule as eval/run.ts result files. */
export function modelSlug(model: string): string {
	return model.replace(/[^a-zA-Z0-9.-]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Eval result files written before eval/run.ts recorded a backend all came from Ollama. */
export const DEFAULT_RESULT_BACKEND = "ollama";

/** Backend an eval result was produced on. */
export function resultBackend(summary: { backend?: unknown }): string {
	return typeof summary.backend === "string" && summary.backend ? summary.backend : DEFAULT_RESULT_BACKEND;
}

/** calibration/<backend>-<model-slug>.json */
export function calibrationFileName(backend: string, model: string): string {
	return `${modelSlug(backend)}-${modelSlug(model)}.json`;
}

export interface ResultEntry<T extends { summary: { model: string; date: string; backend?: unknown } }> {
	file: string;
	data: T;
}

/**
 * Newest eval result per (backend, model). Keying on the model alone would let
 * a later llamacpp run of a model replace its Ollama run (or the reverse).
 */
export function newestPerBackendModel<T extends { summary: { model: string; date: string; backend?: unknown } }>(
	entries: Array<ResultEntry<T>>,
): Array<ResultEntry<T> & { backend: string; model: string }> {
	const out = new Map<string, ResultEntry<T> & { backend: string; model: string }>();
	for (const e of entries) {
		const backend = resultBackend(e.data.summary);
		const model = e.data.summary.model;
		const key = JSON.stringify([backend, model]);
		const prev = out.get(key);
		if (!prev || e.data.summary.date > prev.data.summary.date) out.set(key, { ...e, backend, model });
	}
	return [...out.values()];
}

/**
 * Strict: a malformed file must never loosen the guard. temperature finite and
 * > 0, bias finite, blockAbove in (0, 1), both band ends in [0, 1] with
 * low <= high, and blockAbove >= low so no allow region overlaps a block region.
 */
function isCalibration(x: unknown): x is Calibration {
	if (!x || typeof x !== "object" || Array.isArray(x)) return false;
	const c = x as Calibration;
	const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
	const unit = (v: unknown): v is number => num(v) && v >= 0 && v <= 1;
	if (typeof c.model !== "string" || typeof c.backend !== "string") return false;
	if (!num(c.temperature) || c.temperature <= 0 || !num(c.bias)) return false;
	if (!num(c.blockAbove) || c.blockAbove <= 0 || c.blockAbove >= 1) return false;
	if (!Array.isArray(c.escalateBand) || c.escalateBand.length !== 2) return false;
	const [low, high] = c.escalateBand;
	return unit(low) && unit(high) && low <= high && c.blockAbove >= low;
}

/**
 * Read calibration/<backend>-<model-slug>.json. Null when absent, malformed, or
 * fitted for a different (backend, model): the caller keeps the safe defaults.
 */
export function loadCalibration(model: string, backend: string = DEFAULT_RESULT_BACKEND, dir = CALIBRATION_DIR): Calibration | null {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, calibrationFileName(backend, model)), "utf8"));
		return isCalibration(parsed) && parsed.model === model && parsed.backend === backend ? parsed : null;
	} catch {
		return null;
	}
}
