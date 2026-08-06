/**
 * The primitive set.
 *
 * This is the whole trick, so it is worth stating plainly. "Almost infinite"
 * does not come from a big library of stored designs - packages/design-systems
 * already does that, and it holds 54 themes. It comes from COMBINATORICS over a
 * small number of axes that compose orthogonally. Fourteen axes, none of them
 * with more than 55 positions, multiply out past three billion.
 *
 * The rule that makes it work: an axis is only an axis if moving along it does
 * not invalidate any other axis. Type ratio and accent hue are orthogonal - you
 * can pick any ratio with any hue. Type ratio and quantisation are NOT
 * orthogonal (a 1.067 ratio snapped to a 4px grid collides), which is why
 * quantisation collisions are a CONSTRAINT that refuses, not a fourteenth axis.
 *
 * Every cardinality is derived from the arrays below at runtime by
 * `axisCardinalities()`. There is no hand-written total anywhere in this
 * package: the count in the README is computed by `bun run space.ts` from these
 * exact arrays, so it cannot drift away from the code.
 */

import { gamutMap, renderedHue } from "./color";

// ---------------------------------------------------------------------------
// 1. Type scale ratio.
//
// The canonical modular-scale intervals (modularscale.com, Tim Brown). Only the
// UI-usable band is exposed: below 1.125 adjacent steps collide under pixel
// quantisation, above 1.667 body and h3 are already further apart than any
// interface needs. The musical-interval framing is analogy, not evidence -
// there is no study showing 1.5 reads better than 1.414, so the ratio is a free
// parameter here rather than a recommendation.
// ---------------------------------------------------------------------------

export const TYPE_RATIOS = [
	{ name: "major-second", value: 1.125 },
	{ name: "minor-third", value: 1.2 },
	{ name: "major-third", value: 1.25 },
	{ name: "perfect-fourth", value: 1.333 },
	{ name: "augmented-fourth", value: 1.414 },
	{ name: "perfect-fifth", value: 1.5 },
	{ name: "golden", value: 1.618 },
	{ name: "major-sixth", value: 1.667 },
] as const;

export type TypeRatioName = (typeof TYPE_RATIOS)[number]["name"];

// ---------------------------------------------------------------------------
// 2. Type ramp generator.
//
// Three genuinely different ways to get from a base size to a ramp, taken from
// what mature systems actually ship:
//
//   geometric  base * ratio^n, then snapped to the grid. What everyone teaches.
//   recurrence IBM Carbon's Yn = Yn-1 + (floor((n-2)/4)+1)*2. Quadratic-ish,
//              every value lands on an even pixel by construction. Carbon did
//              not use a modular scale, because modular scales do not quantise.
//   fluid      Utopia's clamp() with the ratio itself interpolated across the
//              viewport (tighter on mobile, looser on desktop).
// ---------------------------------------------------------------------------

export const RAMP_GENERATORS = ["geometric", "recurrence", "fluid"] as const;
export type RampGenerator = (typeof RAMP_GENERATORS)[number];

// ---------------------------------------------------------------------------
// 3. Spacing rhythm: base unit x multiplier family.
//
// Nobody ships a pure geometric spacing ramp - geometric ramps give fractional
// pixels and gaps that are wrong at both ends. Every mature system is a
// hand-picked multiplier vector times ONE generator constant, which is exactly
// what Carbon's `miniUnit = 8` does and what Tailwind v4's `--spacing` does.
// So: the constant is one axis, the multiplier vector is another.
// ---------------------------------------------------------------------------

export const SPACE_UNITS = [4, 5, 8] as const;
export type SpaceUnit = (typeof SPACE_UNITS)[number];

export const SPACE_FAMILIES = {
	/** Carbon's multipliers against miniUnit 8. Hand-tuned, tight at the low end. */
	carbon: [0.25, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12],
	/** Utopia's fluid-space multipliers. Near-geometric but hand-picked. */
	utopia: [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16],
	/** Tailwind v3's linear-then-coarsening ramp, in units of the base. */
	linear: [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 16],
} as const;

export const SPACE_FAMILY_NAMES = Object.keys(SPACE_FAMILIES) as SpaceFamily[];
export type SpaceFamily = keyof typeof SPACE_FAMILIES;

// ---------------------------------------------------------------------------
// 4. Accent hue.
//
// The single largest axis, and the one carrying the brand's hardest rule.
//
// BRAND.md: "Banned hues: 270-350 (purple, pink, violet, magenta)." The band is
// removed from the axis at DEFINITION time, so a banned hue is not merely
// rejected downstream - it has no coordinate. There is no integer you can pass
// to this axis that lands on violet.
//
// That is belt. The braces is `constraints.ts`, which re-checks the RENDERED
// hue of every emitted colour, because the axis is not the only way a colour
// can enter a spec (an override can, a mix can, a future contributor can).
// ---------------------------------------------------------------------------

export const BANNED_HUE_MIN = 270;
export const BANNED_HUE_MAX = 350;
export const HUE_STEP = 5;

/**
 * Legality is established by RENDERING, not by interval arithmetic.
 *
 * This is the subtlest correctness point in the package and it was found by the
 * gate rather than by reasoning. The axis is authored in OKLCH hue angles;
 * BRAND.md's ban is written in conventional colour-wheel degrees. The two
 * spaces disagree by up to about thirty degrees - OKLCH hue 355 renders as a
 * pink whose HSL hue is 342, squarely inside the banned band. Filtering the
 * OKLCH axis against the HSL numbers would therefore have left real magenta
 * reachable while excluding perfectly legal reds.
 *
 * So each candidate OKLCH hue is materialised as an actual accent colour at
 * full chroma and its rendered hue is measured. Only hues whose rendered result
 * lands outside the banned band survive onto the axis. There is no integer a
 * caller can pass that reaches violet, and the property is true by construction
 * rather than by argument.
 *
 * Full chroma is used for the probe deliberately: it is the worst case. A hue
 * that is legal at chroma 0.16 is legal at every lower chroma, because reducing
 * chroma moves a colour towards neutral, not towards magenta.
 */
// Every lightness a palette role can be solved to, sampled densely. A hue
// that is legal at 0.5 can still render inside the banned band at 0.9, where
// gamut mapping has eaten most of the chroma, so probing a narrow band would
// leave a reachable violet. Found by test, not by reasoning.
const PROBE_LIGHTNESSES = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95];
const PROBE_CHROMA = 0.16;

function bannedHue(h: number | null): boolean {
	return h !== null && h >= BANNED_HUE_MIN && h <= BANNED_HUE_MAX;
}

function buildLegalHues(): number[] {
	const hues: number[] = [];
	for (let h = 0; h < 360; h += HUE_STEP) {
		const anyBanned = PROBE_LIGHTNESSES.some((l) =>
			bannedHue(renderedHue(gamutMap({ l, c: PROBE_CHROMA, h }))),
		);
		if (!anyBanned) hues.push(h);
	}
	return hues;
}

/** Every hue the composer may reach. The banned band cannot be addressed. */
export const LEGAL_HUES: readonly number[] = Object.freeze(buildLegalHues());

/**
 * The warm band BRAND.md prefers ("Warm only. No cool grays, no blue-grays").
 * Defined on the RENDERED hue for the same reason as above.
 *
 * This is a PROFILE, not the hard rule: 8gent Games ships neon green and
 * partner integrations may bring their own brand colours, both explicitly
 * exempted in BRAND.md. So warm is the default and the full legal range stays
 * reachable, rather than warm being welded shut.
 */
export const WARM_MAX_HUE = 75;
export const WARM_MIN_HUE = 355;

export const WARM_HUES: readonly number[] = Object.freeze(
	// Swept across EVERY lightness a role can be solved to, and across the
	// reduced chroma the quiet roles use, for the same reason LEGAL_HUES is:
	// probing a single lightness leaves a boundary hue that drifts out of band
	// at another one. Caught by the demo, where accent-quiet at hue 75.6 was
	// refused while its own accent at the same coordinate passed.
	LEGAL_HUES.filter((h) =>
		PROBE_LIGHTNESSES.every((l) =>
			[PROBE_CHROMA, PROBE_CHROMA * 0.5, PROBE_CHROMA * 0.25].every((c) => {
				const rendered = renderedHue(gamutMap({ l, c, h }));
				return rendered === null || rendered <= WARM_MAX_HUE || rendered >= WARM_MIN_HUE;
			}),
		),
	),
);

// ---------------------------------------------------------------------------
// 5. Palette structure: how the accent relates to the secondary.
// ---------------------------------------------------------------------------

export const PALETTE_STRUCTURES = ["mono", "analogous", "complementary", "split"] as const;
export type PaletteStructure = (typeof PALETTE_STRUCTURES)[number];

// ---------------------------------------------------------------------------
// 6. Polarity.
// ---------------------------------------------------------------------------

export const POLARITIES = ["dark", "light"] as const;
export type Polarity = (typeof POLARITIES)[number];

// ---------------------------------------------------------------------------
// 7. Density. Scales spacing and line-height together, because changing one
// without the other is how interfaces end up feeling wrong in a way nobody can
// name.
// ---------------------------------------------------------------------------

export const DENSITIES = {
	compact: { spaceScale: 0.75, lineHeight: 1.5, minTarget: 24 },
	cosy: { spaceScale: 0.875, lineHeight: 1.55, minTarget: 32 },
	comfortable: { spaceScale: 1, lineHeight: 1.6, minTarget: 40 },
	spacious: { spaceScale: 1.25, lineHeight: 1.7, minTarget: 44 },
} as const;

export const DENSITY_NAMES = Object.keys(DENSITIES) as Density[];
export type Density = keyof typeof DENSITIES;

// ---------------------------------------------------------------------------
// 8. Layout skeleton. Every Layout's primitives (Heydon Pickering / Andy Bell),
// each one a CSS mechanism rather than a breakpoint. The Sidebar's flex-basis
// trick and the Switcher's `calc((threshold - 100%) * 999)` step function both
// make the breakpoint a property of the component, not of the viewport, which
// is why they survive being generated rather than hand-tuned.
// ---------------------------------------------------------------------------

export const SKELETONS = ["stack", "sidebar", "switcher", "grid", "cover", "centre"] as const;
export type Skeleton = (typeof SKELETONS)[number];

// ---------------------------------------------------------------------------
// 9. Measure (line length in characters).
//
// Bringhurst's 45-75 is craft. WCAG SC 1.4.8 capping at 80 is spec, and it is
// enforced in constraints.ts. Every value on this axis is legal; the axis
// exists so that a dense dashboard and an essay can differ.
// ---------------------------------------------------------------------------

export const MEASURES = [45, 56, 66, 75] as const;
export type Measure = (typeof MEASURES)[number];

// ---------------------------------------------------------------------------
// 10. Motion personality.
//
// Carbon's 2x3 matrix {productive, expressive} x {standard, entrance, exit} is
// the most directly generative motion token set published, so it is the base.
// The two spring options are Material 3 Expressive's (May 2025) spatial springs,
// where Expressive differs from Standard only by lowering damping and stiffness
// on the spatial axis - a genuine two-parameter personality knob.
// ---------------------------------------------------------------------------

export const MOTION_PERSONALITIES = [
	"productive",
	"expressive",
	"spring-standard",
	"spring-expressive",
] as const;
export type MotionPersonality = (typeof MOTION_PERSONALITIES)[number];

// ---------------------------------------------------------------------------
// 11. Surface treatment: how a raised thing is distinguished from the page.
// ---------------------------------------------------------------------------

export const SURFACES = ["flat", "bordered", "raised", "inset"] as const;
export type Surface = (typeof SURFACES)[number];

// ---------------------------------------------------------------------------
// 12. Emphasis strategy: WHICH channel carries hierarchy.
//
// This is the axis that most changes how a design feels, and the one with the
// least published science behind it. There is no citable metric for "hierarchy
// strength"; see score.ts, where our definition is labelled as ours.
// ---------------------------------------------------------------------------

export const EMPHASIS_STRATEGIES = ["size", "weight", "colour", "space", "size-weight"] as const;
export type EmphasisStrategy = (typeof EMPHASIS_STRATEGIES)[number];

// ---------------------------------------------------------------------------
// 13. Corner radius family. All multiples of 4, following M3's ShapeTokens.
// ---------------------------------------------------------------------------

export const RADIUS_FAMILIES = {
	sharp: [0, 0, 0, 0],
	subtle: [2, 4, 4, 8],
	soft: [4, 8, 12, 16],
	round: [8, 16, 24, 32],
	pill: [8, 16, 999, 999],
} as const;

export const RADIUS_NAMES = Object.keys(RADIUS_FAMILIES) as RadiusFamily[];
export type RadiusFamily = keyof typeof RADIUS_FAMILIES;

// ---------------------------------------------------------------------------
// The lattice.
// ---------------------------------------------------------------------------

/**
 * A point in the design space. Every field is an index or a value drawn from
 * the axes above, so a Coordinate is a complete, serialisable address - two
 * identical Coordinates always compose to two identical DesignSpecs.
 */
export interface Coordinate {
	ratio: TypeRatioName;
	ramp: RampGenerator;
	spaceUnit: SpaceUnit;
	spaceFamily: SpaceFamily;
	accentHue: number;
	structure: PaletteStructure;
	polarity: Polarity;
	density: Density;
	skeleton: Skeleton;
	measure: Measure;
	motion: MotionPersonality;
	surface: Surface;
	emphasis: EmphasisStrategy;
	radius: RadiusFamily;
}

/**
 * Cardinality of every axis, read from the arrays above. This is the source of
 * the number in the README. Nothing here is typed by hand.
 */
export function axisCardinalities(): Record<string, number> {
	return {
		ratio: TYPE_RATIOS.length,
		ramp: RAMP_GENERATORS.length,
		spaceUnit: SPACE_UNITS.length,
		spaceFamily: SPACE_FAMILY_NAMES.length,
		accentHue: LEGAL_HUES.length,
		structure: PALETTE_STRUCTURES.length,
		polarity: POLARITIES.length,
		density: DENSITY_NAMES.length,
		skeleton: SKELETONS.length,
		measure: MEASURES.length,
		motion: MOTION_PERSONALITIES.length,
		surface: SURFACES.length,
		emphasis: EMPHASIS_STRATEGIES.length,
		radius: RADIUS_NAMES.length,
	};
}

/** The product of every axis: the size of the addressable lattice. */
export function latticeSize(): number {
	return Object.values(axisCardinalities()).reduce((a, b) => a * b, 1);
}

/** Enumerate a Coordinate from a single integer index. Total and bijective over
 *  [0, latticeSize()). Used by the counting proof to walk the space without
 *  materialising it. */
export function coordinateAt(index: number): Coordinate {
	if (!Number.isInteger(index) || index < 0 || index >= latticeSize()) {
		throw new RangeError(`lattice index out of range: ${index}`);
	}
	let n = index;
	const take = <T>(arr: readonly T[]): T => {
		const v = arr[n % arr.length];
		n = Math.floor(n / arr.length);
		return v as T;
	};
	return {
		ratio: take(TYPE_RATIOS).name,
		ramp: take(RAMP_GENERATORS),
		spaceUnit: take(SPACE_UNITS),
		spaceFamily: take(SPACE_FAMILY_NAMES),
		accentHue: take(LEGAL_HUES),
		structure: take(PALETTE_STRUCTURES),
		polarity: take(POLARITIES),
		density: take(DENSITY_NAMES),
		skeleton: take(SKELETONS),
		measure: take(MEASURES),
		motion: take(MOTION_PERSONALITIES),
		surface: take(SURFACES),
		emphasis: take(EMPHASIS_STRATEGIES),
		radius: take(RADIUS_NAMES),
	};
}
