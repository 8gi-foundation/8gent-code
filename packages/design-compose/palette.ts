/**
 * Palette construction in OKLCH.
 *
 * Ramps move lightness with hue held fixed, which is the only way to get a
 * neutral ramp that reads evenly and the only way to guarantee that gamut
 * mapping (constant-lightness, constant-hue chroma reduction) cannot migrate a
 * colour into a different hue family. That last property is what makes the
 * brand hue ban safe: reduce chroma all you like, orange stays orange.
 *
 * The neutrals are warm by construction - they carry the accent's hue at very
 * low chroma - which is BRAND.md's "warm only, no cool grays, no blue-grays"
 * expressed as arithmetic rather than as a note in a document.
 *
 * Two kinds of role, and the distinction matters:
 *
 *   LADDER roles (backgrounds, primary and secondary text) come from a fixed
 *   lightness ladder. They have enormous contrast headroom and a fixed ladder
 *   keeps the surface relationships consistent across every hue on the axis.
 *
 *   SOLVED roles (border, tertiary text, accent, on-accent) are the ones whose
 *   entire job is to be legible against something else. Their lightness is
 *   solved for the contrast target rather than guessed, because the lightness
 *   that clears 3:1 at hue 30 does not clear it at hue 200. Guessing them was
 *   the first thing the gate caught when this package was built.
 */

import { CONTRAST_FLOOR, fromHex, gamutMap, type Oklch, renderedHue, rgbToOklch, toHex } from "./color";
import type { PaletteStructure, Polarity } from "./axes";
import { solveLegibleHex } from "./solve";
import { DesignRefused, type ColorRole } from "./types";

/** Fixed ladder for the roles with headroom to spare. */
const LADDER = {
	dark: { bg0: 0.16, bg1: 0.21, bg2: 0.26, bg3: 0.31, textSecondary: 0.79, textPrimary: 0.96 },
	light: { bg0: 0.995, bg1: 0.97, bg2: 0.94, bg3: 0.91, textSecondary: 0.45, textPrimary: 0.19 },
} as const;

const NEUTRAL_CHROMA = 0.008;
const BORDER_CHROMA = 0.014;

/**
 * Accent chroma envelope. sRGB cannot hold high chroma at the extremes, so the
 * envelope tapers; without it the gamut mapper eats the chroma anyway and the
 * accent comes back duller than intended at the ends of the ladder.
 */
export function accentChroma(l: number): number {
	const distanceFromMid = Math.abs(l - 0.55) / 0.55;
	return 0.16 * (1 - 0.65 * distanceFromMid * distanceFromMid);
}

function round(n: number): number {
	return Number(n.toFixed(4));
}

function roleFromOklch(name: string, oklch: Oklch): ColorRole {
	return roleFromHex(name, toHex(gamutMap(oklch)));
}

function roleFromHex(name: string, hex: string): ColorRole {
	const rgb = fromHex(hex);
	const actual = rgbToOklch(rgb);
	return {
		name,
		hex,
		oklch: { l: round(actual.l), c: round(actual.c), h: round(actual.h) },
		renderedHue: renderedHue(rgb),
	};
}

/**
 * Secondary hue derived from the accent by the palette structure.
 *
 * The rotation is by POSITION IN THE AVAILABLE HUE SET, not by absolute
 * degrees, and that is the single most important correctness decision in this
 * file. It was found by measurement, not by reasoning.
 *
 * The obvious implementation is degrees: complementary is accent + 180. Under
 * the warm profile that is wrong in a way that shows up immediately - a warm
 * accent plus 180 degrees is always a cool blue, so 58 per cent of the warm
 * lattice was being refused by the warm rule, and the structure axis had
 * silently stopped being orthogonal to the hue axis. Orthogonality is the
 * property the whole combinatorial count rests on, so a violation of it is not
 * a cosmetic problem.
 *
 * Rotating by position fixes it and is also what a designer actually does when
 * working inside a constrained palette: "complementary" in a warm-only system
 * means the far end of the warm range - a rust accent against a deep amber -
 * not a blue. The relationship is preserved, the legality is structural.
 *
 * Result: every derived hue is legal BY CONSTRUCTION, in every profile. The
 * brand rules in constraints.ts still check it, because pins and overrides can
 * introduce a colour this function never saw.
 */
const STRUCTURE_FRACTION: Record<PaletteStructure, number> = {
	mono: 0,
	analogous: 1 / 8,
	split: 1 / 3,
	complementary: 1 / 2,
};

export function secondaryHue(accent: number, structure: PaletteStructure, available: readonly number[]): number {
	if (available.length === 0) return accent;
	const at = available.indexOf(accent);
	// An accent outside the profile's set (an explicit pin) rotates in degrees,
	// which is the honest fallback: we cannot rotate within a set it is not in.
	if (at < 0) return ((accent + STRUCTURE_FRACTION[structure] * 360) % 360 + 360) % 360;
	const step = Math.round(STRUCTURE_FRACTION[structure] * available.length);
	return available[(at + step) % available.length] as number;
}

export interface PaletteInput {
	accentHue: number;
	structure: PaletteStructure;
	polarity: Polarity;
	emphasis: string;
	/** The hue set this profile may address. Structures rotate within it. */
	available: readonly number[];
}

export function buildPalette(input: PaletteInput): ColorRole[] {
	const { accentHue: h, structure, polarity, emphasis, available } = input;
	const ladder = LADDER[polarity];
	const h2 = secondaryHue(h, structure, available);
	// In dark mode a legible role must be LIGHTER than the page; in light mode,
	// darker. Everything solved below searches in that direction.
	const away = polarity === "dark" ? "lighter" : "darker";

	const roles: ColorRole[] = [
		roleFromOklch("bg-0", { l: ladder.bg0, c: NEUTRAL_CHROMA, h }),
		roleFromOklch("bg-1", { l: ladder.bg1, c: NEUTRAL_CHROMA, h }),
		roleFromOklch("bg-2", { l: ladder.bg2, c: NEUTRAL_CHROMA, h }),
		roleFromOklch("bg-3", { l: ladder.bg3, c: NEUTRAL_CHROMA, h }),
		roleFromOklch("text-primary", { l: ladder.textPrimary, c: NEUTRAL_CHROMA, h }),
		roleFromOklch("text-secondary", { l: ladder.textSecondary, c: NEUTRAL_CHROMA, h }),
	];

	// The busiest background is the one a border or a quiet text role has to
	// survive. Solve against bg-2, not bg-0, so the solved roles hold across the
	// whole surface stack rather than only against the darkest or lightest.
	const bg2 = fromHex(roles[2]?.hex as string);
	const bg0 = fromHex(roles[0]?.hex as string);

	const solved = (
		name: string,
		chromaFor: (l: number) => number,
		against: ReturnType<typeof fromHex>,
		target: number,
		hue: number,
	): ColorRole => {
		const hit = solveLegibleHex(hue, chromaFor, against, target, away);
		if (!hit) {
			throw new DesignRefused(
				"a11y.contrast",
				`no lightness at hue ${hue} can give role "${name}" ${target}:1 against the ${polarity} surface. This hue cannot carry that role at this chroma.`,
			);
		}
		return roleFromHex(name, hit.hex);
	};

	// Non-text boundary: WCAG 2.2 SC 1.4.11, 3:1. Solved against bg-2 with a
	// small margin so it also clears against bg-0 and bg-1.
	roles.push(solved("border", () => BORDER_CHROMA, bg2, CONTRAST_FLOOR.nonText + 0.15, h));
	// Tertiary text is large-text-only by contract: 3:1.
	roles.push(solved("text-tertiary", () => NEUTRAL_CHROMA, bg2, CONTRAST_FLOOR.large + 0.15, h));
	// The accent is used for large text and for interactive boundaries: 3:1.
	const accent = solved("accent", accentChroma, bg2, CONTRAST_FLOOR.large + 0.2, h);
	roles.push(accent);

	// A quiet accent for hover states and fills. No contrast contract of its
	// own, so it stays on the ladder side of the accent.
	const quietL = polarity === "dark" ? Math.max(0.3, accent.oklch.l - 0.18) : Math.min(0.9, accent.oklch.l + 0.2);
	roles.push(roleFromOklch("accent-quiet", { l: quietL, c: accentChroma(quietL) * 0.5, h }));
	roles.push(roleFromOklch("secondary", { l: accent.oklch.l, c: accentChroma(accent.oklch.l) * 0.8, h: h2 }));

	// Text ON the accent: body contrast, 4.5:1, and the direction is whichever
	// end of the range the accent is NOT at. Try the far end first; if the
	// accent sits in the mid-lightness dead zone where neither end works, that
	// is a genuine refusal and it propagates.
	const accentRgb = fromHex(accent.hex);
	const onAccent =
		solveLegibleHex(h, () => NEUTRAL_CHROMA, accentRgb, CONTRAST_FLOOR.body, "darker") ??
		solveLegibleHex(h, () => NEUTRAL_CHROMA, accentRgb, CONTRAST_FLOOR.body, "lighter");
	if (!onAccent) {
		throw new DesignRefused(
			"a11y.contrast",
			`accent ${accent.hex} sits in the mid-lightness dead zone: neither a near-black nor a near-white foreground reaches 4.5:1 on it. No legible label can be placed on this accent.`,
		);
	}
	roles.push(roleFromHex("on-accent", onAccent.hex));

	if (emphasis === "colour") {
		// Colour-led hierarchy needs a rung between accent and body text so that
		// emphasis has somewhere to live that is not just "accent or not accent".
		roles.push(solved("emphasis", (l) => accentChroma(l) * 0.4, bg0, CONTRAST_FLOOR.body, h));
	}

	return roles;
}

/**
 * The pairs that MUST hold. Declared here rather than inferred, because a
 * contrast gate that only checks the pairs it happens to notice is not a gate.
 *
 * Requirements follow WCAG 2.2: SC 1.4.3 body text 4.5:1 and large text 3:1,
 * SC 1.4.11 non-text (borders, focus rings, UI boundaries) 3:1.
 */
export const REQUIRED_PAIRS: { fg: string; bg: string; requirement: "body" | "large" | "nonText" }[] = [
	{ fg: "text-primary", bg: "bg-0", requirement: "body" },
	{ fg: "text-primary", bg: "bg-1", requirement: "body" },
	{ fg: "text-primary", bg: "bg-2", requirement: "body" },
	{ fg: "text-secondary", bg: "bg-0", requirement: "body" },
	{ fg: "text-secondary", bg: "bg-1", requirement: "body" },
	{ fg: "text-tertiary", bg: "bg-0", requirement: "large" },
	{ fg: "text-tertiary", bg: "bg-2", requirement: "large" },
	{ fg: "accent", bg: "bg-0", requirement: "large" },
	{ fg: "accent", bg: "bg-2", requirement: "large" },
	{ fg: "on-accent", bg: "accent", requirement: "body" },
	{ fg: "border", bg: "bg-0", requirement: "nonText" },
	{ fg: "border", bg: "bg-2", requirement: "nonText" },
];
