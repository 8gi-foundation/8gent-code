/**
 * 8gent Code - Visualiser Operator Types
 *
 * Each operator is a React component that fills a width x height grid
 * inside the Thinking box. Operators read the shared param vector and
 * a monotonic tick counter, render their own glyphs, and stay strictly
 * inside their bounds. They never spawn timers - the parent composer
 * owns the clock.
 */

import type { ParamVector } from "../../lib/visualiser-params.js";

export interface OperatorProps {
	/** Box width in columns. */
	width: number;
	/** Box height in rows. */
	height: number;
	/** Shared param vector. */
	params: ParamVector;
	/** Monotonic frame counter. */
	tick: number;
	/** Dim factor 0..1 for crossfade. 1 = full bright, 0.3 = dimmed-out. */
	brightness: number;
	/** Optional centred label that operators must avoid (cleared region). */
	avoid?: { x: number; y: number; width: number; height: number };
}

export type OperatorComponent = (props: OperatorProps) => React.ReactElement;

export const OPERATOR_NAMES = [
	"NoiseField",
	"ParticleDrift",
	"GradientSpectrum",
	"RuneDance",
	"OctagonOrbit",
	"GlyphRain",
] as const;

export type OperatorName = (typeof OPERATOR_NAMES)[number];
