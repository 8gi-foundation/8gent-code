/**
 * The composer. intent -> coordinate -> spec.
 *
 * Determinism is a hard property, not an aspiration. There is no Math.random in
 * this package and no clock read. Variation comes from an explicit `seed` in the
 * intent, mixed with the intent's own text through FNV-1a, which is a published
 * fixed function rather than anything host-dependent. Same intent, same spec,
 * on any machine, forever. That is what makes a design reproducible from a
 * chat message six months later.
 *
 * Two layers, deliberately separable:
 *   resolve(intent)      -> Coordinate   which point in the lattice
 *   composeAt(coord)     -> DesignSpec   what that point actually is
 * so a spec can be replayed from its coordinate alone, without the intent, and
 * a coordinate can be nudged one axis at a time to explore a neighbourhood.
 */

import {
	type Coordinate,
	DENSITIES,
	DENSITY_NAMES,
	EMPHASIS_STRATEGIES,
	LEGAL_HUES,
	MEASURES,
	MOTION_PERSONALITIES,
	PALETTE_STRUCTURES,
	POLARITIES,
	RADIUS_NAMES,
	RAMP_GENERATORS,
	SKELETONS,
	SPACE_FAMILY_NAMES,
	SPACE_UNITS,
	SURFACES,
	TYPE_RATIOS,
	WARM_HUES,
} from "./axes";
import { gate } from "./constraints";
import { buildLayout } from "./layout";
import { buildMotion } from "./motion";
import { buildPalette } from "./palette";
import { buildRadii, buildSpaceRamp, buildTypeRamp } from "./scales";
import { scoreDesign } from "./score";
import { DesignRefused, type DesignIntent, type DesignSpec, type TypeStep } from "./types";

// ---------------------------------------------------------------------------
// Deterministic mixing.
// ---------------------------------------------------------------------------

/** FNV-1a, 32-bit. Fixed, published, host-independent. */
function fnv1a(text: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

/** Independent draws from one seed: each axis gets its own salted stream, so
 *  adding an axis does not reshuffle every existing design. */
function draw<T>(seedText: string, axis: string, options: readonly T[]): T {
	return options[fnv1a(`${axis}:${seedText}`) % options.length] as T;
}

// ---------------------------------------------------------------------------
// Tones: named presets that pin some axes and leave the rest free.
//
// A tone is the officer's whole vocabulary for "how should this feel". It is
// deliberately a small closed set: an open-ended adjective would push the
// interpretation back into the model, which is the cost this substrate exists
// to remove.
// ---------------------------------------------------------------------------

export const TONES: Record<string, Partial<Coordinate>> = {
	/** Long-form reading. Generous measure, quiet motion, size-led hierarchy. */
	editorial: {
		ratio: "perfect-fourth",
		measure: 66,
		density: "comfortable",
		emphasis: "size",
		motion: "productive",
		skeleton: "centre",
		surface: "flat",
	},
	/** Dense operational surfaces. Tight rhythm, fast motion, weight-led. */
	console: {
		ratio: "major-second",
		measure: 45,
		density: "compact",
		emphasis: "weight",
		motion: "productive",
		skeleton: "sidebar",
		surface: "bordered",
		radius: "subtle",
	},
	/** Presentation and pitch. Large ramp, expressive motion, high contrast. */
	stage: {
		ratio: "golden",
		measure: 45,
		density: "spacious",
		emphasis: "size-weight",
		motion: "expressive",
		skeleton: "cover",
		surface: "flat",
	},
	/** Product marketing. Colour-led emphasis, springy, card-based. */
	showcase: {
		ratio: "major-third",
		measure: 56,
		density: "comfortable",
		emphasis: "colour",
		motion: "spring-expressive",
		skeleton: "grid",
		surface: "raised",
		radius: "soft",
	},
	/** Forms and settings. Space-led grouping, restrained motion. */
	utility: {
		ratio: "minor-third",
		measure: 56,
		density: "cosy",
		emphasis: "space",
		motion: "productive",
		skeleton: "stack",
		surface: "inset",
	},
};

export const TONE_NAMES = Object.keys(TONES);

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

export function resolve(intent: DesignIntent): Coordinate {
	const tone = intent.tone ?? "";
	if (tone && !TONES[tone]) {
		throw new DesignRefused(
			"intent.tone",
			`unknown tone ${JSON.stringify(tone)}. Known tones: ${TONE_NAMES.join(", ")}.`,
		);
	}
	const preset = tone ? TONES[tone] : undefined;
	const seedText = `${intent.product}|${tone}|${intent.seed ?? 0}`;
	const hues = intent.warmOnly === false ? LEGAL_HUES : WARM_HUES;

	const base: Coordinate = {
		ratio: draw(seedText, "ratio", TYPE_RATIOS).name,
		ramp: draw(seedText, "ramp", RAMP_GENERATORS),
		spaceUnit: draw(seedText, "spaceUnit", SPACE_UNITS),
		spaceFamily: draw(seedText, "spaceFamily", SPACE_FAMILY_NAMES),
		accentHue: draw(seedText, "accentHue", hues),
		structure: draw(seedText, "structure", PALETTE_STRUCTURES),
		polarity: draw(seedText, "polarity", POLARITIES),
		density: draw(seedText, "density", DENSITY_NAMES),
		skeleton: draw(seedText, "skeleton", SKELETONS),
		measure: draw(seedText, "measure", MEASURES),
		motion: draw(seedText, "motion", MOTION_PERSONALITIES),
		surface: draw(seedText, "surface", SURFACES),
		emphasis: draw(seedText, "emphasis", EMPHASIS_STRATEGIES),
		radius: draw(seedText, "radius", RADIUS_NAMES),
	};

	// Tone pins beat the seed; explicit pins beat the tone. Nothing else can
	// move an axis, which is what keeps replay honest.
	return { ...base, ...preset, ...(intent.pin ?? {}) };
}

// ---------------------------------------------------------------------------
// composeAt
// ---------------------------------------------------------------------------

/** Base body size by density. The one number everything else is measured from. */
const BASE_PX: Record<string, number> = {
	compact: 14,
	cosy: 15,
	comfortable: 16,
	spacious: 18,
};

/**
 * The baseline grid, and the one place density is allowed to act.
 *
 * Density scales the GENERATOR CONSTANT, not the generated values. That is the
 * Carbon and Tailwind v4 pattern - Carbon has one `miniUnit = 8` and a
 * multiplier vector, Tailwind v4 replaced its whole stored ramp with
 * `calc(var(--spacing) * n)` - and it matters here for a concrete reason.
 * Scaling the values instead would take a 4px unit at 1.25 density and produce
 * 5, 10, 15, 20, none of which is a multiple of the 4px baseline, so the
 * vertical rhythm the type ramp is snapped to would not exist in the spacing
 * ramp. Scaling the constant keeps one grid.
 *
 * Müller-Brockmann's construction runs from the type outward: choose type size
 * and leading first, and the baseline IS the leading. This is the same idea
 * expressed through a token system, with the effective unit as the granularity
 * everything vertical snaps to.
 */
function effectiveUnit(spaceUnit: number, densityScale: number): number {
	return Math.max(2, Math.round(spaceUnit * densityScale));
}

export function composeAt(coordinate: Coordinate, intent: DesignIntent): DesignSpec {
	const density = DENSITIES[coordinate.density];
	const basePx = BASE_PX[coordinate.density] ?? 16;
	const baselinePx = effectiveUnit(coordinate.spaceUnit, density.spaceScale);

	const rawType = buildTypeRamp({
		basePx,
		ratio: coordinate.ratio,
		generator: coordinate.ramp,
		baselinePx,
		lineHeightTarget: density.lineHeight,
		emphasis: coordinate.emphasis,
	});

	const type: TypeStep[] = rawType.map((t) => ({
		role: t.role,
		px: t.px,
		lineHeightPx: t.lineHeightPx,
		lineHeight: Number((t.lineHeightPx / t.px).toFixed(4)),
		weight: t.weight,
		tracking: t.tracking,
		fluid: t.fluid,
	}));

	// The ramp is built from the effective unit at scale 1: density has already
	// been applied to the constant, and applying it twice would double it.
	const space = buildSpaceRamp(baselinePx, coordinate.spaceFamily);
	const radius = buildRadii(coordinate.radius);
	const colors = buildPalette({
		accentHue: coordinate.accentHue,
		structure: coordinate.structure,
		polarity: coordinate.polarity,
		emphasis: coordinate.emphasis,
		available: intent.warmOnly === false ? LEGAL_HUES : WARM_HUES,
	});
	const motion = buildMotion(coordinate.motion);

	const spaceMd = space.find((s) => s.name === "m")?.px ?? coordinate.spaceUnit * 2;
	const spaceLg = space.find((s) => s.name === "l")?.px ?? coordinate.spaceUnit * 3;
	const layout = buildLayout(coordinate.skeleton, coordinate.measure, coordinate.density, spaceMd, spaceLg);

	const partial = {
		coordinate,
		intent,
		id: coordinateId(coordinate),
		baselinePx,
		type,
		space,
		radius,
		colors,
		motion,
		layout,
	};

	// The gate. Throws DesignRefused rather than returning a warning.
	const pairs = gate(partial);

	const score = scoreDesign(type, space, radius, colors, pairs, baselinePx, coordinate.emphasis);

	return { ...partial, pairs, score };
}

/** Stable id: a hash of the coordinate only. Two identical coordinates always
 *  produce the same id, whatever intent text produced them. */
export function coordinateId(c: Coordinate): string {
	const canonical = Object.keys(c)
		.sort()
		.map((k) => `${k}=${(c as unknown as Record<string, unknown>)[k]}`)
		.join(";");
	return fnv1a(canonical).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// compose, and ranked search.
// ---------------------------------------------------------------------------

export function compose(intent: DesignIntent): DesignSpec {
	return composeAt(resolve(intent), intent);
}

/**
 * Walk a neighbourhood of the lattice by varying the seed, keep the specs that
 * pass the gate, and rank them. This is what makes "almost infinite" useful
 * rather than merely large: the officer names an intent, code enumerates
 * candidates, the gate throws away the illegal ones, and the scorer orders what
 * is left. The model never sees a candidate it did not ask for.
 *
 * `refusals` is returned, not swallowed. A search where 40 of 64 candidates
 * were refused is telling you something about the intent.
 */
export interface SearchResult {
	best: DesignSpec;
	ranked: DesignSpec[];
	refusals: { seed: number; rule: string; detail: string }[];
	considered: number;
}

export function search(intent: DesignIntent, candidates = 64): SearchResult {
	const ranked: DesignSpec[] = [];
	const refusals: { seed: number; rule: string; detail: string }[] = [];

	for (let i = 0; i < candidates; i += 1) {
		const seed = (intent.seed ?? 0) + i;
		try {
			ranked.push(compose({ ...intent, seed }));
		} catch (err) {
			if (err instanceof DesignRefused) {
				refusals.push({ seed, rule: err.rule, detail: err.detail });
				continue;
			}
			throw err;
		}
	}

	if (ranked.length === 0) {
		throw new DesignRefused(
			"search.exhausted",
			`all ${candidates} candidates for ${JSON.stringify(intent.product)} were refused. First reason: ${refusals[0]?.detail ?? "unknown"}`,
		);
	}

	// Ties break on id, so the ordering is total and reproducible.
	ranked.sort((a, b) => b.score.total - a.score.total || a.id.localeCompare(b.id));
	return { best: ranked[0] as DesignSpec, ranked, refusals, considered: candidates };
}
