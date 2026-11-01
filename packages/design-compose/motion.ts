/**
 * Motion tokens, and the reduced-motion rule.
 *
 * The important structural decision: a MotionToken cannot be constructed
 * without its reduced variant. `reduced` is not optional and there is no code
 * path that produces a token lacking it. That is the difference between an
 * accessibility guideline and an accessibility guarantee - if the field can be
 * absent, one day it will be.
 *
 * The rule itself is substitute, not kill. WebKit's own guidance on the media
 * query it shipped: "Consider serving an alternate, simpler animation", and
 * "Unless a specific animation is likely to cause a problem, removing it
 * prematurely only succeeds in making your site unnecessarily boring." MDN's
 * canonical example replaces a transform-scale pulse with an opacity dissolve.
 * The blanket `animation-duration: 0.01ms !important` reset is a misreading.
 *
 * So the derivation is a pure function of the animated PROPERTY:
 *   transform / size  -> substitute a cross-fade, same duration
 *   opacity / colour  -> keep unchanged
 * which means it can be enforced at emit time rather than trusted to authors.
 */

import type { MotionPersonality } from "./axes";
import type { MotionToken } from "./types";

/**
 * Carbon's easing curves, verbatim from packages/motion/src/dtcg/motion.json.
 * The clean 2x3 structure is why this is the base rather than Material's:
 * entrance zeroes the first control point (starts at full speed out of
 * nothing), exit pins the third to 1 (accelerates off screen).
 */
const CARBON_EASING = {
	productive: {
		standard: [0.2, 0, 0.38, 0.9],
		entrance: [0, 0, 0.38, 0.9],
		exit: [0.2, 0, 1, 0.9],
	},
	expressive: {
		standard: [0.4, 0.14, 0.3, 1],
		entrance: [0, 0, 0.3, 1],
		exit: [0.4, 0.14, 1, 1],
	},
} as const;

/** Carbon durations, ms, verbatim. */
const CARBON_DURATION = {
	"fast-01": 70,
	"fast-02": 110,
	"moderate-01": 150,
	"moderate-02": 240,
	"slow-01": 400,
	"slow-02": 700,
} as const;

/**
 * Material 3 spatial springs, from StandardMotionTokens.kt and
 * ExpressiveMotionTokens.kt. Two invariants fall out of the published tables
 * and both are load-bearing here: Effects springs are identical across both
 * schemes and always critically damped (damping 1.0, no overshoot on colour or
 * opacity), and Expressive differs from Standard only on the spatial axis.
 */
const SPRINGS = {
	"spring-standard": {
		spatialFast: { damping: 0.9, stiffness: 1400 },
		spatialDefault: { damping: 0.9, stiffness: 700 },
		spatialSlow: { damping: 0.9, stiffness: 300 },
	},
	"spring-expressive": {
		spatialFast: { damping: 0.6, stiffness: 800 },
		spatialDefault: { damping: 0.8, stiffness: 380 },
		spatialSlow: { damping: 0.8, stiffness: 200 },
	},
} as const;

const EFFECTS_SPRINGS = {
	fast: { damping: 1.0, stiffness: 3800 },
	default: { damping: 1.0, stiffness: 1600 },
	slow: { damping: 1.0, stiffness: 800 },
} as const;

type Axis = MotionToken["axis"];

/**
 * The reduced-motion derivation. Pure function of the axis. The duration is
 * preserved deliberately: the user asked for less motion, not for the interface
 * to start teleporting, and a same-duration cross-fade keeps the temporal
 * relationship between the change and its cause.
 */
function reduceFor(axis: Axis, durationMs: number): MotionToken["reduced"] {
	if (axis === "opacity" || axis === "colour") {
		return { durationMs, axis, note: "unchanged: no vestibular trigger" };
	}
	return {
		durationMs,
		axis: "opacity",
		note: "cross-fade substituted for positional motion",
	};
}

function token(
	name: string,
	durationMs: number,
	easing: [number, number, number, number] | null,
	spring: { damping: number; stiffness: number } | null,
	axis: Axis,
): MotionToken {
	return { name, durationMs, easing, spring, axis, reduced: reduceFor(axis, durationMs) };
}

export function buildMotion(personality: MotionPersonality): MotionToken[] {
	if (personality === "productive" || personality === "expressive") {
		const e = CARBON_EASING[personality];
		return [
			token("hover", CARBON_DURATION["fast-01"], [...e.standard] as [number, number, number, number], null, "colour"),
			token("toggle", CARBON_DURATION["fast-02"], [...e.standard] as [number, number, number, number], null, "transform"),
			token("enter", CARBON_DURATION["moderate-01"], [...e.entrance] as [number, number, number, number], null, "transform"),
			token("exit", CARBON_DURATION["moderate-01"], [...e.exit] as [number, number, number, number], null, "transform"),
			token("expand", CARBON_DURATION["moderate-02"], [...e.standard] as [number, number, number, number], null, "size"),
			token("overlay", CARBON_DURATION["slow-01"], [...e.entrance] as [number, number, number, number], null, "opacity"),
		];
	}

	const s = SPRINGS[personality];
	// Springs have no duration; the millisecond figures here are the settling
	// time a consumer should budget for, not a driving parameter. They are
	// reported so a reduced-motion cross-fade has a duration to inherit.
	return [
		token("hover", 70, null, EFFECTS_SPRINGS.fast, "colour"),
		token("toggle", 110, null, s.spatialFast, "transform"),
		token("enter", 250, null, s.spatialDefault, "transform"),
		token("exit", 200, null, s.spatialFast, "transform"),
		token("expand", 350, null, s.spatialSlow, "size"),
		token("overlay", 300, null, EFFECTS_SPRINGS.default, "opacity"),
	];
}
