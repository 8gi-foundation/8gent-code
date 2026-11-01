/**
 * Type ramps and spacing rhythms. Pure arithmetic, no state, no randomness.
 *
 * The one design decision worth defending here: line heights are computed in
 * PIXELS on the baseline grid and the unitless CSS value is derived from them,
 * rather than the other way round. That is what Tailwind v4 and Material 3 both
 * actually do (M3 hand-picks sizes but every line height is a multiple of 4;
 * Tailwind stores absolute line heights on a 4px grid and divides at build
 * time). Deriving px from a unitless ratio gives fractional pixels and the
 * vertical rhythm falls apart at the third heading.
 */

import { RADIUS_FAMILIES, type RadiusFamily, SPACE_FAMILIES, type SpaceFamily, TYPE_RATIOS, type TypeRatioName } from "./axes";

/** Semantic roles, largest first. The ramp always has exactly these steps. */
export const TYPE_ROLES = [
	"display",
	"h1",
	"h2",
	"h3",
	"body-lg",
	"body",
	"caption",
] as const;

/** Step offsets from body, so `body` is always step 0 and always the base size. */
const ROLE_STEPS: Record<string, number> = {
	display: 5,
	h1: 4,
	h2: 3,
	h3: 2,
	"body-lg": 1,
	body: 0,
	caption: -1,
};

export function ratioValue(name: TypeRatioName): number {
	const found = TYPE_RATIOS.find((r) => r.name === name);
	if (!found) throw new Error(`unknown type ratio: ${name}`);
	return found.value;
}

/** Snap up to the nearest multiple of `unit`. Never down: rounding a type size
 *  down can collide it with the step below, and a collision is a refusal. */
function snapUp(value: number, unit: number): number {
	return Math.ceil(value / unit) * unit;
}

/**
 * Quantisation grain by size. 1px below 20px, 2px above.
 *
 * A single 2px grain collides at the small end - at base 14 with a major-second
 * ratio, body and caption both snap to 14 and the ramp has no hierarchy at all
 * in the size channel. That is a real refusal the gate catches, but it makes an
 * otherwise sensible tone unusable, and the fix is the one every shipped system
 * already applies: fine grain where the steps are close together, coarse grain
 * where they are far apart. Tailwind's ramp is 12, 14, 16, 18, 20 then 24, 30,
 * 36; Carbon's recurrence widens its increment every four steps for the same
 * reason. This is optical-size-appropriate quantisation, not a fudge.
 */
function grainFor(px: number): number {
	return px < 20 ? 1 : 2;
}

function quantise(value: number): number {
	return snapUp(value, grainFor(value));
}

/**
 * Line-height target tapers as type grows.
 *
 * A 1.7 line box is correct for body copy and absurd on a 200px display
 * heading, where it opens a gap the height of a paragraph between two lines of
 * a title. Every shipped system handles this and none of them does it with a
 * single ratio: Tailwind collapses line-height to exactly 1 above 3rem;
 * Material 3's Display Large is 57/64, a ratio of 1.12, against Body Medium's
 * 14/20 at 1.43.
 *
 * So the target holds up to 24px (which is where SC 1.4.12's text-spacing
 * requirement stops being about blocks of text) and then decays linearly
 * towards 1.1 by 64px. Below 24px nothing changes, so the accessibility floor
 * is untouched.
 */
const DISPLAY_LINE_HEIGHT = 1.1;

function lineHeightFor(px: number, target: number): number {
	if (px <= 24) return target;
	const t = Math.min(1, (px - 24) / (64 - 24));
	return target + (DISPLAY_LINE_HEIGHT - target) * t;
}

/**
 * IBM Carbon's type-scale recurrence, verbatim from packages/type/src/scale.ts:
 *
 *   getTypeSize(step) = step <= 1 ? 12 : getTypeSize(step-1) + (floor((step-2)/4)+1) * 2
 *
 * The increment grows by 2 every 4 steps, so every value lands on an even pixel
 * by construction. This is the counterexample worth keeping in the substrate:
 * the most mature system in the survey did not use a modular scale at all,
 * because modular scales do not quantise.
 */
export function carbonTypeSize(step: number): number {
	if (step <= 1) return 12;
	return carbonTypeSize(step - 1) + (Math.floor((step - 2) / 4) + 1) * 2;
}

/**
 * Utopia's fluid clamp, using Pedro Rodriguez's formula as published at
 * utopia.fyi/blog/clamp:
 *
 *   slope         = (maxSize - minSize) / (maxWidth - minWidth)
 *   yIntersection = -minWidth * slope + minSize
 *   clamp(minSize, yIntersection + slope*100vw, maxSize)
 *
 * All arithmetic in rem, which is why every term is divided by 16.
 */
export function fluidClamp(
	minPx: number,
	maxPx: number,
	minViewportPx = 360,
	maxViewportPx = 1240,
): string {
	const toRem = (px: number) => px / 16;
	const slope = (toRem(maxPx) - toRem(minPx)) / (toRem(maxViewportPx) - toRem(minViewportPx));
	const intersection = -1 * toRem(minViewportPx) * slope + toRem(minPx);
	const r = (n: number) => Number(n.toFixed(4));
	return `clamp(${r(toRem(minPx))}rem, ${r(intersection)}rem + ${r(slope * 100)}vw, ${r(toRem(maxPx))}rem)`;
}

/**
 * WCAG SC 1.4.4 check for a fluid ramp, from Utopia's checkWCAG (credited to
 * Maxwell Barvian). A clamp expression can fail "resize text to 200% without
 * loss of content" over a range of viewports even though both endpoints look
 * fine, because the slope flattens the growth. Returns the failing viewport
 * range in px, or null when the ramp is safe across the whole span.
 *
 * This is the shape of hard constraint worth having: a formula that tells you a
 * ramp is invalid, and exactly where.
 */
export function fluidResizeFailure(
	minPx: number,
	maxPx: number,
	minViewportPx: number,
	maxViewportPx: number,
): { from: number; to: number } | null {
	const slope = (maxPx - minPx) / (maxViewportPx - minViewportPx);
	if (slope <= 0) return null;
	const intercept = minPx - minViewportPx * slope;
	// z5 = font size at 500% zoom, 2*z1 = the SC 1.4.4 requirement. Solving
	// z5 < 2*z1 gives the boundaries below.
	const lh = (5 * minPx - 2 * intercept) / (2 * slope);
	const rh = (5 * intercept - 2 * maxPx) / (-1 * slope);
	const lh2 = (3 * intercept) / slope;
	const from = maxViewportPx < 5 * minViewportPx ? lh : lh2;
	const to = rh;
	if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
	const clampedFrom = Math.max(from, minViewportPx);
	const clampedTo = Math.min(to, maxViewportPx);
	if (clampedTo <= clampedFrom) return null;
	return { from: Math.round(clampedFrom), to: Math.round(clampedTo) };
}

export interface RampInput {
	basePx: number;
	ratio: TypeRatioName;
	generator: "geometric" | "recurrence" | "fluid";
	baselinePx: number;
	/** Density line-height target, e.g. 1.6. Line heights snap up from this. */
	lineHeightTarget: number;
	emphasis: string;
}

export interface RawTypeStep {
	role: string;
	px: number;
	lineHeightPx: number;
	weight: number;
	tracking: number;
	fluid: string | null;
}

/**
 * Weights per role, chosen by the emphasis strategy. When hierarchy is carried
 * by size, weights stay flat and the ramp does the work; when it is carried by
 * weight, the size ramp is still present but the weight delta is what a reader
 * actually sees first.
 */
function weightFor(role: string, emphasis: string): number {
	const step = ROLE_STEPS[role] ?? 0;
	switch (emphasis) {
		case "weight":
			return step >= 4 ? 800 : step >= 2 ? 700 : step >= 1 ? 600 : 400;
		case "size-weight":
			return step >= 4 ? 700 : step >= 2 ? 600 : 400;
		case "size":
		case "colour":
		case "space":
			return step >= 2 ? 600 : 400;
		default:
			return 400;
	}
}

/**
 * Optical tracking. Negative on display sizes, positive on the smallest, zero
 * in the middle - the hand correction Material 3 applies across its whole type
 * scale (Display Large -0.2, Label Small +0.5, most of the middle at 0). It is
 * craft, not a law, and it is applied as a fixed table rather than a formula
 * for exactly that reason.
 */
function trackingFor(role: string): number {
	const step = ROLE_STEPS[role] ?? 0;
	if (step >= 5) return -0.02;
	if (step >= 3) return -0.01;
	if (step <= -1) return 0.01;
	return 0;
}

export function buildTypeRamp(input: RampInput): RawTypeStep[] {
	const { basePx, ratio, generator, baselinePx, lineHeightTarget, emphasis } = input;
	const r = ratioValue(ratio);

	return TYPE_ROLES.map((role) => {
		const step = ROLE_STEPS[role] ?? 0;
		let px: number;

		if (generator === "recurrence") {
			// Carbon indexes from step 1 = 12px. Body sits at the index whose value
			// is closest to the requested base, and the roles walk outward from it.
			let bodyIndex = 1;
			let best = Number.POSITIVE_INFINITY;
			for (let i = 1; i <= 23; i += 1) {
				const d = Math.abs(carbonTypeSize(i) - basePx);
				if (d < best) {
					best = d;
					bodyIndex = i;
				}
			}
			px = carbonTypeSize(Math.max(1, bodyIndex + step * 2));
		} else {
			// Geometric and fluid share the same static ramp; fluid adds a clamp()
			// on top, with the ratio interpolated across the viewport the way
			// utopia-core does (tighter on mobile than on desktop).
			px = quantise(basePx * r ** step);
		}

		// Line height in pixels first, then snapped to the baseline. This is the
		// invariant that makes vertical rhythm hold: every line box is an exact
		// whole number of baselines.
		//
		// NEAREST, not up. Ceiling looks safer and is not: body at 18px with a
		// 5px baseline wants 30.6px, and rounding up gives 35px - a line-height
		// of 1.94, which is 17 per cent looser than asked for and reads as a
		// mistake. Rounding to the nearest multiple gives 30px. The floor
		// protects the accessibility case: a body-sized role never drops below
		// 1.5, which is what SC 1.4.12 needs headroom for.
		const target = lineHeightFor(px, lineHeightTarget);
		const floorRatio = px <= 24 ? 1.5 : 1.0;
		const nearest = Math.round((px * target) / baselinePx) * baselinePx;
		const lineHeightPx =
			nearest / px >= floorRatio ? nearest : Math.ceil((px * floorRatio) / baselinePx) * baselinePx;

		let fluid: string | null = null;
		if (generator === "fluid") {
			// A step whose min and max coincide is not fluid, and emitting
			// clamp(1.125rem, 1.125rem + 0vw, 1.125rem) is noise pretending to be
			// a decision. Body sits at step 0 where both ends use ratio^0, so this
			// is the common case, not an edge case.
			// Interpolated ratio: 1.2 at the small end, the chosen ratio at the
			// large end. utopia-core's minTypeScale/maxTypeScale, same idea.
			const minPx = quantise(basePx * 1.2 ** step);
			const lo = Math.min(minPx, px);
			const hi = Math.max(minPx, px);
			fluid = lo === hi ? null : fluidClamp(lo, hi);
		}

		return {
			role,
			px,
			lineHeightPx,
			weight: weightFor(role, emphasis),
			tracking: trackingFor(role),
			fluid,
		};
	});
}

export const SPACE_NAMES = [
	"3xs",
	"2xs",
	"xs",
	"s",
	"m",
	"l",
	"xl",
	"2xl",
	"3xl",
	"4xl",
	"5xl",
	"6xl",
] as const;

/**
 * Spacing ramp: a hand-picked multiplier vector times ONE generator constant,
 * scaled by density, then snapped to the grid. Carbon's `miniUnit` and
 * Tailwind v4's `--spacing` are both this shape, and both are the reason the
 * ramp stays coherent when the constant moves.
 */
export function buildSpaceRamp(unit: number, family: SpaceFamily): { name: string; px: number }[] {
	const multipliers = SPACE_FAMILIES[family];
	// Whole pixels, always. A half-unit grain looks tidier on paper and produces
	// 2.5px at unit 5, which is not a spacing value - it is a rounding error the
	// browser will resolve differently in different places. Rounding to whole
	// pixels can collide two adjacent steps at aggressive densities, and that
	// collision is REFUSED by assertSpacingDistinct rather than smoothed over.
	return multipliers.map((m, i) => ({
		name: SPACE_NAMES[i] ?? `s${i}`,
		px: Math.max(1, Math.round(unit * m)),
	}));
}

export function buildRadii(family: RadiusFamily): { name: string; px: number }[] {
	const names = ["sm", "md", "lg", "xl"];
	return RADIUS_FAMILIES[family].map((px, i) => ({ name: names[i] as string, px }));
}
