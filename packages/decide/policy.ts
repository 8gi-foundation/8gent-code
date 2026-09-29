/**
 * 8J-D student policy: when the student may answer, and when it defers to
 * today's System One path. Code owns every threshold; the student only
 * reports probabilities (student.ts).
 *
 * The student answers class c (the argmax) only when ALL hold:
 *   - no block rule fired (the guard blocks those before the student);
 *   - the command fits in the encoder window (not truncated);
 *   - it is in distribution (kNN score within the 99th percentile);
 *   - probs[c] >= thresholds[c].
 * A rules.ts escalate can only make the answer stricter (allow becomes ask).
 * The comment-stripped form is judged too; the stricter answer wins and a
 * deferral on either form defers.
 *
 * Thresholds are fitted strictest-first (block, then ask, then allow) with a
 * one-sided 95% Clopper-Pearson upper bound over ALL calibration rows:
 *   severe = student allow where the truth is block   (budget 0.5%)
 *   mild   = any other student answer != truth         (budget 5%)
 */

export const CLASSES = ["allow", "ask", "block"] as const;
export type Verdict = (typeof CLASSES)[number];
export type Answer = Verdict | "defer";
export type RuleFloor = "pass" | "escalate" | "block";

export interface Thresholds {
	allow: number;
	ask: number;
	block: number;
}
/** Never answer: every class deferred. */
export const DEFER_ALL: Thresholds = {
	allow: Number.POSITIVE_INFINITY,
	ask: Number.POSITIVE_INFINITY,
	block: Number.POSITIVE_INFINITY,
};

export interface Budgets {
	/** Upper bound on P(student allow AND truth block). Default 0.005. */
	severe: number;
	/** Upper bound on P(student answer != truth, other than severe). Default 0.05. */
	mild: number;
	/** One-sided confidence. Default 0.95. */
	confidence: number;
}
export const DEFAULT_BUDGETS: Budgets = { severe: 0.005, mild: 0.05, confidence: 0.95 };

const RANK: Record<Verdict, number> = { allow: 0, ask: 1, block: 2 };
export const stricter = (a: Verdict, b: Verdict): Verdict => (RANK[a] >= RANK[b] ? a : b);

function argmax(p: readonly number[]): number {
	let best = 0;
	for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
	return best;
}

/** One form's answer: the argmax class when it clears its threshold, else defer. */
export function classAnswer(probs: readonly number[], t: Thresholds): Answer {
	if (probs.length !== 3 || probs.some((x) => !Number.isFinite(x))) return "defer";
	const c = CLASSES[argmax(probs)];
	return probs[argmax(probs)] >= t[c] ? c : "defer";
}

export interface StudentInput {
	/** One distribution per judged form (as written, and comment-stripped when it differs). */
	forms: readonly (readonly number[])[];
	ood: boolean;
	truncated: boolean;
	rule: RuleFloor;
}

/** The student's answer for a command, or "defer". Never less strict than the rules. */
export function studentAnswer(x: StudentInput, t: Thresholds): Answer {
	if (x.rule === "block" || x.ood || x.truncated || x.forms.length === 0) return "defer";
	let out: Verdict | null = null;
	for (const f of x.forms) {
		const a = classAnswer(f, t);
		if (a === "defer") return "defer";
		out = out ? stricter(out, a) : a;
	}
	if (!out) return "defer";
	return x.rule === "escalate" ? stricter(out, "ask") : out;
}

// ----- Clopper-Pearson ------------------------------------------------------------

function logGamma(x: number): number {
	const c = [
		676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
		12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
	];
	if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
	x -= 1;
	let a = 0.9999999999998099;
	const t = x + 7.5;
	for (let i = 0; i < 8; i++) a += c[i] / (x + i + 1);
	return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function betacf(a: number, b: number, x: number): number {
	const EPS = 3e-16;
	const FPMIN = 1e-300;
	let c = 1;
	let d = 1 - ((a + b) * x) / (a + 1);
	if (Math.abs(d) < FPMIN) d = FPMIN;
	d = 1 / d;
	let h = d;
	for (let m = 1; m <= 1000; m++) {
		const m2 = 2 * m;
		let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
		d = 1 + aa * d;
		if (Math.abs(d) < FPMIN) d = FPMIN;
		c = 1 + aa / c;
		if (Math.abs(c) < FPMIN) c = FPMIN;
		d = 1 / d;
		h *= d * c;
		aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
		d = 1 + aa * d;
		if (Math.abs(d) < FPMIN) d = FPMIN;
		c = 1 + aa / c;
		if (Math.abs(c) < FPMIN) c = FPMIN;
		d = 1 / d;
		const del = d * c;
		h *= del;
		if (Math.abs(del - 1) < EPS) break;
	}
	return h;
}

/** Regularised incomplete beta I_x(a, b). */
export function betaInc(x: number, a: number, b: number): number {
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	const bt = Math.exp(
		logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
	);
	return x < (a + 1) / (a + b + 2)
		? (bt * betacf(a, b, x)) / a
		: 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Inverse of I_x(a, b) in x, by bisection (monotone, 200 steps: exact to double precision). */
export function betaInv(p: number, a: number, b: number): number {
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 200; i++) {
		const mid = (lo + hi) / 2;
		if (betaInc(mid, a, b) < p) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

/** One-sided Clopper-Pearson upper bound on a rate with k events in n trials. */
export function cpUpper(k: number, n: number, confidence = 0.95): number {
	if (n <= 0) return 1;
	if (k >= n) return 1;
	return betaInv(confidence, k + 1, n - k);
}

/** One-sided Clopper-Pearson lower bound. */
export function cpLower(k: number, n: number, confidence = 0.95): number {
	if (n <= 0 || k <= 0) return 0;
	return betaInv(1 - confidence, k, n - k + 1);
}

/** Two-sided Clopper-Pearson interval at `confidence` (default 95%). */
export function cpInterval(k: number, n: number, confidence = 0.95): [number, number] {
	const tail = (1 + confidence) / 2;
	return [cpLower(k, n, tail), cpUpper(k, n, tail)];
}

// ----- fitting ---------------------------------------------------------------------

export interface CalibrationRow extends StudentInput {
	truth: Verdict;
}

export interface Counts {
	n: number;
	answered: number;
	severe: number;
	mild: number;
}

export function countErrors(rows: readonly CalibrationRow[], t: Thresholds): Counts {
	let answered = 0;
	let severe = 0;
	let mild = 0;
	for (const r of rows) {
		const a = studentAnswer(r, t);
		if (a === "defer") continue;
		answered++;
		if (a === "allow" && r.truth === "block") severe++;
		else if (a !== r.truth) mild++;
	}
	return { n: rows.length, answered, severe, mild };
}

export function withinBudget(c: Counts, b: Budgets = DEFAULT_BUDGETS): boolean {
	return (
		cpUpper(c.severe, c.n, b.confidence) <= b.severe && cpUpper(c.mild, c.n, b.confidence) <= b.mild
	);
}

export interface FitResult {
	thresholds: Thresholds;
	counts: Counts;
	severeUpper: number;
	mildUpper: number;
	budgets: Budgets;
}

/**
 * Strictest-first fit. For block, then ask, then allow: lower that class's
 * threshold through the candidate values (the class's own argmax probabilities
 * on calibration rows) while the whole policy stays within both budgets. Error
 * counts only grow as a threshold drops, so the scan stops at the first breach.
 */
export function fitThresholds(
	rows: readonly CalibrationRow[],
	budgets: Budgets = DEFAULT_BUDGETS,
): FitResult {
	const t: Thresholds = { ...DEFER_ALL };
	for (const c of ["block", "ask", "allow"] as const) {
		const ci = CLASSES.indexOf(c);
		const cands = new Set<number>();
		for (const r of rows)
			for (const f of r.forms) if (f.length === 3 && argmax(f) === ci) cands.add(f[ci]);
		const sorted = [...cands].sort((a, b) => b - a);
		for (const v of sorted) {
			const trial = { ...t, [c]: v };
			if (!withinBudget(countErrors(rows, trial), budgets)) break;
			t[c] = v;
		}
	}
	const counts = countErrors(rows, t);
	return {
		thresholds: t,
		counts,
		severeUpper: cpUpper(counts.severe, counts.n, budgets.confidence),
		mildUpper: cpUpper(counts.mild, counts.n, budgets.confidence),
		budgets,
	};
}
