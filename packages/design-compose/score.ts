/**
 * The scorer. Ranking only. Nothing here can fail a design.
 *
 * Read this file with suspicion, because it is the thinnest part of the
 * substrate and pretending otherwise would be the exact kind of dressing-up
 * the brand voice forbids. What the survey of the literature actually found:
 *
 *   contrast   Normative and unambiguous. But it is a CONSTRAINT, so it lives
 *              in constraints.ts. What is left to score is headroom above the
 *              floor, which is a real signal but a weak one.
 *
 *   hierarchy  There is NO published scalar metric called "hierarchy strength".
 *              Nothing in computational aesthetics defines one. The circulating
 *              rules of thumb ("below 1.125 hierarchy becomes ambiguous") are
 *              blogs and tool marketing with no cited experiment. The definition
 *              below is OURS. It is stated precisely so it can be argued with,
 *              and it is not presented as a finding.
 *
 *   rhythm     Measurable, because we defined the invariant. It is a
 *              conformance count, not an aesthetic judgement.
 *
 *   restraint  Ngo's economy measure ECM = 1 / n_size is real, published, and
 *              trivially computable. Its validation is weak: two experiments,
 *              six greyscale layouts on an overhead projector, no correlation
 *              coefficient reported, and the authors themselves flag both
 *              load-bearing assumptions as unjustified. Reinecke's CHI 2013
 *              complexity model is far stronger (R-squared .65) but it operates
 *              on rendered SCREENSHOTS, not on token specs, so it cannot be
 *              applied here without rendering. Noted as future work rather than
 *              faked.
 *
 * The weights are a judgement call and are not derived from anything.
 */

import { contrastRatio, fromHex } from "./color";
import { CONTRAST_FLOOR } from "./color";
import type { ColorRole, ContrastPair, DesignScore, TypeStep } from "./types";

/**
 * Worst headroom across the declared pairs, expressed as a multiple of the
 * floor that pair had to clear, then squashed to 0-1. A design sitting exactly
 * on 4.5:1 everywhere scores 0; one at 2x its floors scores 1.
 */
export function contrastHeadroom(pairs: ContrastPair[]): number {
	if (pairs.length === 0) return 0;
	let worst = Number.POSITIVE_INFINITY;
	for (const p of pairs) {
		worst = Math.min(worst, p.ratio / CONTRAST_FLOOR[p.requirement]);
	}
	return clamp01((worst - 1) / 1);
}

/**
 * OUR definition of hierarchy strength. Not a citable metric.
 *
 * Hierarchy is carried by up to three channels at once - size, weight, and
 * colour lightness - and a design is only strongly hierarchical if the channels
 * that are IN USE separate adjacent semantic ranks by a consistent, visible
 * amount. So:
 *
 *   for each adjacent pair of type roles, take the log ratio of their sizes and
 *   the normalised weight delta; take the minimum across pairs of the combined
 *   separation, because hierarchy is only as strong as its weakest adjacency;
 *   add the colour channel only when the emphasis strategy actually uses it.
 *
 * The minimum rather than the mean is the one part worth defending: a ramp that
 * is dramatic at the top and flat in the middle reads as flat, and averaging
 * would hide exactly that.
 */
export function hierarchyStrength(type: TypeStep[], colors: ColorRole[], emphasis: string): number {
	if (type.length < 2) return 0;

	let worst = Number.POSITIVE_INFINITY;
	for (let i = 1; i < type.length; i += 1) {
		const bigger = type[i - 1] as TypeStep;
		const smaller = type[i] as TypeStep;
		// log ratio normalised against a perfect fifth, which is a generous
		// upper anchor rather than a claim about perception.
		const sizeSep = Math.log(bigger.px / smaller.px) / Math.log(1.5);
		const weightSep = Math.abs(bigger.weight - smaller.weight) / 400;
		// Channels combine sub-additively: two weak signals do not add up to one
		// strong one, but they do help.
		worst = Math.min(worst, Math.sqrt(sizeSep * sizeSep + weightSep * weightSep));
	}

	let score = clamp01(worst);

	if (emphasis === "colour") {
		const primary = colors.find((c) => c.name === "text-primary");
		const secondary = colors.find((c) => c.name === "text-secondary");
		if (primary && secondary) {
			const delta = contrastRatio(fromHex(primary.hex), fromHex(secondary.hex));
			// A colour channel that separates ranks by less than 1.3:1 is not
			// carrying hierarchy, it is just noise.
			score = clamp01(score + Math.min(0.2, Math.max(0, (delta - 1.3) / 5)));
		}
	}

	return score;
}

/**
 * Rhythm conformance: the fraction of vertical values that land exactly on the
 * baseline. Because assertBaselineRhythm already refuses anything that does
 * not, this scores 1.0 for every spec the gate lets through - which is the
 * correct behaviour for a conformance measure and worth saying out loud rather
 * than dressing up as insight. It earns its place by scoring the SPACING ramp,
 * which is not gated, only the type ramp is.
 */
export function rhythmConsistency(
	type: TypeStep[],
	space: { name: string; px: number }[],
	baselinePx: number,
): number {
	const values = [...type.map((t) => t.lineHeightPx), ...space.map((s) => s.px)];
	if (values.length === 0) return 0;
	const onGrid = values.filter((v) => v % baselinePx === 0).length;
	return onGrid / values.length;
}

/**
 * Ngo and Byrne's economy measure, ECM = 1 / n_size, where n_size is the number
 * of distinct object sizes. Published in the open-access Ngo and Byrne (2001),
 * Int. J. Appl. Math. Comput. Sci. 11(2), 515-535. Fewer distinct sizes scores
 * higher, full stop.
 *
 * Applied here to the union of type sizes, spacing values and radii, because
 * those are the sizes a token spec actually determines. Rescaled so that a
 * realistic token set does not sit at 0.03: the raw 1/n is only useful as an
 * ordering, and the rescale preserves the ordering.
 */
export function restraint(
	type: TypeStep[],
	space: { name: string; px: number }[],
	radius: { name: string; px: number }[],
): number {
	const distinct = new Set<number>();
	for (const t of type) distinct.add(t.px);
	for (const s of space) distinct.add(s.px);
	for (const r of radius) distinct.add(r.px);
	const n = distinct.size;
	// 12 distinct sizes scores ~1, 30 scores ~0. Linear rescale of an ordering.
	return clamp01((30 - n) / 18);
}

const WEIGHTS = { contrast: 0.3, hierarchy: 0.3, rhythm: 0.2, restraint: 0.2 } as const;

export function scoreDesign(
	type: TypeStep[],
	space: { name: string; px: number }[],
	radius: { name: string; px: number }[],
	colors: ColorRole[],
	pairs: ContrastPair[],
	baselinePx: number,
	emphasis: string,
): DesignScore {
	const c = contrastHeadroom(pairs);
	const h = hierarchyStrength(type, colors, emphasis);
	const r = rhythmConsistency(type, space, baselinePx);
	const e = restraint(type, space, radius);
	const total = c * WEIGHTS.contrast + h * WEIGHTS.hierarchy + r * WEIGHTS.rhythm + e * WEIGHTS.restraint;
	return {
		contrastHeadroom: round(c),
		hierarchy: round(h),
		rhythm: round(r),
		restraint: round(e),
		total: round(total),
	};
}

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.min(1, Math.max(0, n));
}

function round(n: number): number {
	return Number(n.toFixed(4));
}
