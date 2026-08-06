/**
 * Contrast as an INPUT, not an outcome.
 *
 * The naive way to build a palette is to pick lightness values that look right,
 * emit them, and check the contrast afterwards. That fails constantly, because
 * the lightness that clears 4.5:1 depends on the hue and the chroma, and no
 * fixed ladder is right for all 55 hues on the axis.
 *
 * So roles whose whole job is to be legible against something else are SOLVED
 * for instead: given a hue, a chroma envelope and a background, find the
 * lightness that hits the contrast target. This is the Leonardo pattern (Adobe's
 * contrast-driven colour tool) rebuilt as a bisection: contrast against a fixed
 * background is monotonic in lightness on each side of the background, so
 * bisection is exact and, importantly, deterministic.
 *
 * This is generation, not silent correction. The officer's intent is the HUE
 * and the tone. Lightness is a derived value the composer is free to solve for.
 * When no lightness in range can hit the target, that IS refused - see the
 * `null` return and its caller.
 */

import { contrastRatio, fromHex, gamutMap, type Rgb, toHex } from "./color";

const BISECTION_STEPS = 40;

/**
 * Find the lightness in [lo, hi] whose colour hits `target` contrast against
 * `against`, searching in `direction`. Returns null when even the extreme end
 * of the range cannot reach the target, which is the honest answer for an
 * accent sitting in the mid-lightness dead zone against a mid-lightness page.
 *
 * `chromaFor` is a function rather than a constant because sRGB cannot hold the
 * same chroma at L 0.2 and L 0.9, and solving with a fixed chroma just hands
 * the problem to the gamut mapper.
 */
export function solveLightness(
	hue: number,
	chromaFor: (l: number) => number,
	against: Rgb,
	target: number,
	direction: "lighter" | "darker",
): number | null {
	const at = (l: number): Rgb => gamutMap({ l, c: chromaFor(l), h: hue });

	// Search from the background outward to the extreme. Contrast increases
	// monotonically as we move away from the background luminance, so the
	// extreme is the best case: if it fails, nothing in range works.
	const [lo, hi] = direction === "lighter" ? [0.0, 1.0] : [1.0, 0.0];
	if (contrastRatio(at(hi), against) < target) return null;

	// Bisect for the value CLOSEST to the background that still clears the
	// target. Closest is what we want: an accent that clears 4.5:1 by miles is
	// an accent that has been bleached to near-white.
	let near = lo;
	let far = hi;
	for (let i = 0; i < BISECTION_STEPS; i += 1) {
		const mid = (near + far) / 2;
		if (contrastRatio(at(mid), against) >= target) far = mid;
		else near = mid;
	}
	return far;
}

/**
 * Solve, then confirm. The solver works in continuous lightness but the output
 * is an 8-bit hex, and rounding can drop a colour a hundredth below the floor.
 * So the returned lightness is walked outward in small steps until the ROUNDED
 * hex genuinely clears the target. Returns null if it never does.
 */
export function solveLegibleHex(
	hue: number,
	chromaFor: (l: number) => number,
	against: Rgb,
	target: number,
	direction: "lighter" | "darker",
): { l: number; hex: string } | null {
	const start = solveLightness(hue, chromaFor, against, target, direction);
	if (start === null) return null;
	const step = direction === "lighter" ? 0.004 : -0.004;
	for (let i = 0; i < 60; i += 1) {
		const l = Math.min(1, Math.max(0, start + step * i));
		const hex = toHex(gamutMap({ l, c: chromaFor(l), h: hue }));
		if (contrastRatio(fromHex(hex), against) >= target) return { l, hex };
	}
	return null;
}
