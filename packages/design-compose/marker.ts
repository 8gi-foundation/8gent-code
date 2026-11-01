/**
 * [[DESIGN ...]] marker parsing.
 *
 * Same family and same tolerance philosophy as helm-bridge's parseProposal and
 * packages/verify's [[CLAIM]]: the 9-12B local models these officers run on
 * truncate markers, close brackets early, and reorder keys. A marker we can
 * still make sense of is parsed, not rejected. Rigor lives in the COMPOSER and
 * the GATE, not in the punctuation.
 *
 * Grammar, one line:
 *   [[DESIGN product=huddle-deck tone=stage]]
 *   [[DESIGN product=table-pane tone=console polarity=dark seed=3]]
 *   [[DESIGN product=landing tone=showcase warm=false candidates=32]]
 *
 * Values are single tokens, no spaces, which every field here is by
 * construction. `product` is the only free-text field and it is slug-shaped.
 */

import type { Coordinate } from "./axes";
import {
	DENSITY_NAMES,
	EMPHASIS_STRATEGIES,
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
} from "./axes";
import { TONE_NAMES } from "./compose";
import type { DesignIntent } from "./types";

const DESIGN_RE = /\[\[DESIGN\s+([\s\S]*?)(?:\]\]|$)/g;

/** Keys that are intent metadata rather than lattice pins. */
const META_KEYS = new Set(["product", "tone", "seed", "warm", "candidates"]);

/** Which axis a pin key belongs to, and what values it accepts. Unknown pins
 *  are dropped rather than rejected: a truncated model is more likely to emit
 *  garbage than to mean something we have not implemented. */
const PIN_DOMAINS: Record<string, readonly string[]> = {
	ratio: TYPE_RATIOS.map((r) => r.name),
	ramp: RAMP_GENERATORS,
	spaceFamily: SPACE_FAMILY_NAMES,
	structure: PALETTE_STRUCTURES,
	polarity: POLARITIES,
	density: DENSITY_NAMES,
	skeleton: SKELETONS,
	motion: MOTION_PERSONALITIES,
	surface: SURFACES,
	emphasis: EMPHASIS_STRATEGIES,
	radius: RADIUS_NAMES,
};

/** Numeric pins, with their legal value sets. */
const NUMERIC_PINS: Record<string, readonly number[]> = {
	spaceUnit: SPACE_UNITS,
	measure: MEASURES,
};

export interface ParsedDesign {
	intent: DesignIntent;
	/** How many lattice points to search and rank. */
	candidates: number;
	/** The marker text exactly as it appeared, for substitution. */
	raw: string;
}

function parsePairs(body: string): Record<string, string> {
	const pairs: Record<string, string> = {};
	for (const m of body.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)=(\S+)/g)) {
		// Strip a trailing "]" from an early-closed bracket, same salvage as
		// parseProposal.
		pairs[m[1] as string] = (m[2] as string).replace(/\]+$/, "");
	}
	return pairs;
}

/** Parse every [[DESIGN]] marker in document order. */
export function parseDesignMarkers(reply: string): ParsedDesign[] {
	const out: ParsedDesign[] = [];

	for (const m of reply.matchAll(DESIGN_RE)) {
		const pairs = parsePairs(m[1] as string);
		const pin: Partial<Coordinate> = {};

		for (const [k, v] of Object.entries(pairs)) {
			if (META_KEYS.has(k)) continue;
			const domain = PIN_DOMAINS[k];
			if (domain?.includes(v)) {
				(pin as Record<string, unknown>)[k] = v;
				continue;
			}
			const numeric = NUMERIC_PINS[k];
			if (numeric) {
				const n = Number(v);
				if (numeric.includes(n)) (pin as Record<string, unknown>)[k] = n;
				continue;
			}
			if (k === "hue" || k === "accentHue") {
				const n = Number(v);
				// Not validated against the ban here on purpose. An out-of-band hue
				// must reach the GATE so the officer is told it was refused, rather
				// than being silently dropped at the parser and replaced by a legal
				// one it never asked for.
				if (Number.isFinite(n)) (pin as Record<string, unknown>).accentHue = ((n % 360) + 360) % 360;
			}
		}

		const seed = Number(pairs.seed);
		const candidates = Number(pairs.candidates);
		const tone = pairs.tone && TONE_NAMES.includes(pairs.tone) ? pairs.tone : undefined;

		out.push({
			intent: {
				product: pairs.product ?? "untitled",
				tone,
				pin: Object.keys(pin).length ? pin : undefined,
				seed: Number.isFinite(seed) ? seed : 0,
				warmOnly: pairs.warm === "false" ? false : true,
			},
			candidates: Number.isFinite(candidates) && candidates > 0 ? Math.min(256, Math.floor(candidates)) : 32,
			raw: m[0] as string,
		});
	}

	return out;
}

/**
 * Officer-facing instructions, appended to an officer's system prompt by the
 * daemon. Same voice and same shape as OFFICER_CLAIM_PROMPT in packages/verify.
 *
 * The point of the last two lines: an officer that writes out a palette in
 * prose has already burned the tokens this substrate exists to save, and has
 * almost certainly written something that would not pass the gate.
 */
export const OFFICER_DESIGN_PROMPT = [
	"When you specify a look, a theme, a palette, a type scale, or any visual",
	"treatment, NEVER write the values yourself. Do not list colours, sizes,",
	"spacing, or easing curves. Write a design marker and the system composes a",
	"complete, contrast-checked, brand-legal spec and inserts it:",
	"  [[DESIGN product=<slug> tone=<tone>]]",
	`Tones: ${TONE_NAMES.join(", ")}.`,
	"Optional pins, only when you actually need one: polarity=dark|light,",
	"density=compact|cosy|comfortable|spacious, skeleton=stack|sidebar|switcher|",
	"grid|cover|centre, emphasis=size|weight|colour|space|size-weight,",
	"motion=productive|expressive|spring-standard|spring-expressive, seed=<n>.",
	"seed= gives you a different design from the same intent, reproducibly.",
	"The composer refuses anything that breaks a rule rather than fixing it",
	"quietly, so a refusal is information: it means the intent was wrong.",
	"You never pick a hex. You never write a spacing scale. You state intent.",
].join("\n");
