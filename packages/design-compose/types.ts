/**
 * The contract. The action-layer twin is [[TASK]]/[[HELM]]; the data-layer twin
 * is [[CLAIM]]/[[DERIVE]] in packages/verify. This is the design layer.
 *
 * An officer NEVER writes a design. It writes an INTENT - a handful of words
 * naming what the thing is for and how it should feel - and code composes the
 * complete spec: type ramp, spacing rhythm, colour system with every pair
 * contrast-checked, layout skeleton, motion tokens with reduced-motion variants,
 * surfaces, radii. The model never enumerates a spacing scale, never picks a
 * hex, never does arithmetic on a ratio. It states an intent and receives a
 * spec that is complete by construction and legal by refusal.
 */

import type { Coordinate } from "./axes";

/** What the officer states. Deliberately tiny - this is the token budget. */
export interface DesignIntent {
	/** What is being designed. Free text; hashed, never parsed for meaning. */
	product: string;
	/** Named tone preset. Pins some axes; see TONES in compose.ts. */
	tone?: string;
	/** Optional explicit pins. Anything not pinned is derived from the seed. */
	pin?: Partial<Coordinate>;
	/** Reproducible variation. Same seed, same product, same tone, same spec. */
	seed?: number;
	/** Restrict the accent to BRAND.md's warm band. Defaults true. */
	warmOnly?: boolean;
}

export interface TypeStep {
	/** Semantic name: body, h1, caption, and so on. */
	role: string;
	/** Rendered size in CSS px, after quantisation. */
	px: number;
	/** Line height in CSS px. Always an exact multiple of the baseline. */
	lineHeightPx: number;
	/** Unitless line-height for CSS, derived. */
	lineHeight: number;
	weight: number;
	/** Letter spacing in em. Negative only on display sizes. */
	tracking: number;
	/** clamp() expression when the ramp generator is fluid, else null. */
	fluid: string | null;
}

export interface ColorRole {
	name: string;
	hex: string;
	/** OKLCH authoring coordinates, kept so a consumer can re-derive. */
	oklch: { l: number; c: number; h: number };
	/** Hue of the rendered pixel, 0-360, or null when achromatic. */
	renderedHue: number | null;
}

export interface ContrastPair {
	fg: string;
	bg: string;
	/** WCAG 2.2 contrast ratio. */
	ratio: number;
	/** Which floor this pair must clear. */
	requirement: "body" | "large" | "nonText";
	/** Advisory Oklab lightness separation. Not a standard. */
	separation: number;
}

export interface MotionToken {
	name: string;
	durationMs: number;
	/** cubic-bezier control points, or null for a spring. */
	easing: [number, number, number, number] | null;
	spring: { damping: number; stiffness: number } | null;
	/** Which visual property this token animates. Drives the reduced variant. */
	axis: "opacity" | "colour" | "transform" | "size";
	/** What this token becomes under prefers-reduced-motion: reduce.
	 *  Never absent - it is constructed alongside, so it cannot be forgotten. */
	reduced: { durationMs: number; axis: "opacity" | "colour"; note: string };
}

export interface LayoutSpec {
	skeleton: string;
	/** Line measure in characters. Capped at 80 by SC 1.4.8. */
	measureCh: number;
	/** The CSS mechanism this skeleton uses, emitted as a rule body. */
	css: string;
	/** Minimum interactive target in CSS px. SC 2.5.8 floor is 24. */
	minTargetPx: number;
	/** Grid track expression where the skeleton has one. */
	track: string | null;
}

export interface DesignSpec {
	/** The address this spec was composed at. Replay is `composeAt(coordinate)`. */
	coordinate: Coordinate;
	/** The intent it came from, for provenance. */
	intent: DesignIntent;
	/** Stable identifier: a hash of the coordinate. Same coordinate, same id. */
	id: string;
	baselinePx: number;
	type: TypeStep[];
	space: { name: string; px: number }[];
	radius: { name: string; px: number }[];
	colors: ColorRole[];
	pairs: ContrastPair[];
	motion: MotionToken[];
	layout: LayoutSpec;
	/** Scores. Advisory ranking only; nothing here can fail a spec. */
	score: DesignScore;
}

export interface DesignScore {
	/** Worst WCAG headroom across declared pairs, as a multiple of the floor. */
	contrastHeadroom: number;
	/** Our own definition; see score.ts. Not a citable metric. */
	hierarchy: number;
	/** Fraction of vertical values that land exactly on the baseline. */
	rhythm: number;
	/** Ngo-style economy: fewer distinct sizes scores higher. */
	restraint: number;
	/** Weighted total, 0-1. */
	total: number;
}

/**
 * A refusal. Thrown, never returned as a warning, and never silently corrected.
 *
 * This is the whole point of the constraint layer. A design that violates a
 * hard rule should be IMPOSSIBLE to emit, not discouraged. If the composer
 * quietly nudged a violet accent to orange, nobody would ever learn that the
 * intent was wrong; the refusal is the evidence.
 */
export class DesignRefused extends Error {
	constructor(
		/** Machine-readable rule id, e.g. "brand.hue". */
		readonly rule: string,
		/** What was rejected. */
		readonly detail: string,
	) {
		super(`design refused [${rule}]: ${detail}`);
		this.name = "DesignRefused";
	}
}
