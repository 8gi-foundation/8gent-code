/**
 * The gate.
 *
 * Every function here THROWS. None of them warns, none of them corrects, none
 * of them returns a "fixed" value. That is the entire design of this file, and
 * it is worth being explicit about why.
 *
 * A composer that silently nudged a violet accent to orange would produce a
 * valid design and destroy the information that the intent was wrong. Moira
 * would never learn it, the officer that emitted the intent would never learn
 * it, and the rule would quietly rot until someone shipped violet by hand and
 * nothing complained. The refusal IS the evidence, exactly like the planted-lie
 * test in packages/verify: the value of the substrate is not that it produces
 * good designs, it is that it cannot produce bad ones without saying so.
 *
 * Accessibility rules live here, not in score.ts. A score can be traded away
 * against another score. Contrast cannot.
 */

import { BANNED_HUE_MAX, BANNED_HUE_MIN, WARM_MAX_HUE, WARM_MIN_HUE } from "./axes";
import { CONTRAST_FLOOR, contrastRatio, fromHex, lightnessSeparation, renderedHue } from "./color";
import { MAX_MEASURE_CH, MIN_TARGET_PX } from "./layout";
import { REQUIRED_PAIRS } from "./palette";
import { DesignRefused } from "./types";
import type { ColorRole, ContrastPair, DesignSpec, MotionToken, TypeStep } from "./types";

// ---------------------------------------------------------------------------
// brand.hue
// ---------------------------------------------------------------------------

/**
 * BRAND.md: "Banned hues: 270-350 (purple, pink, violet, magenta)."
 *
 * Checked on the RENDERED pixel, so it cannot be evaded. It does not matter
 * whether the colour arrived as an OKLCH triple, a hex override, a gamut-mapped
 * approximation, or a hand-written token: it is converted to the sRGB a human
 * will see, and that colour's hue is judged. Achromatic colours are exempt
 * because a grey has no hue to ban.
 */
export function assertBrandHue(colors: ColorRole[]): void {
	for (const c of colors) {
		const hue = c.renderedHue ?? renderedHue(fromHex(c.hex));
		if (hue === null) continue;
		if (hue >= BANNED_HUE_MIN && hue <= BANNED_HUE_MAX) {
			throw new DesignRefused(
				"brand.hue",
				`role "${c.name}" renders as ${c.hex}, hue ${hue.toFixed(1)} degrees, inside the banned band ${BANNED_HUE_MIN}-${BANNED_HUE_MAX} (purple, pink, violet, magenta). BRAND.md forbids it. Not corrected - choose a different accent.`,
			);
		}
	}
}

/**
 * brand.warm - the PROFILE, not the ban.
 *
 * BRAND.md says "Warm only. No cool grays, no blue-grays", and separately
 * exempts partner integrations, accessibility modes, white-label deployments
 * and 8gent Games. So warm is a default that can be switched off with
 * warmOnly: false, and it is a distinct rule id from brand.hue so a refusal
 * says which one bit.
 *
 * This exists because of a real gap the demo exposed. Restricting the ACCENT
 * axis to warm hues is not enough: a split-complementary structure rotates the
 * accent by 150 degrees, so a warm olive accent produced a cornflower blue
 * secondary that passed the hue ban and had no business in a warm palette. The
 * profile has to apply to every chromatic role the palette actually emits, not
 * just to the one the officer named.
 */
export function assertWarmProfile(colors: ColorRole[]): void {
	for (const c of colors) {
		const hue = c.renderedHue;
		if (hue === null) continue;
		if (hue <= WARM_MAX_HUE || hue >= WARM_MIN_HUE) continue;
		throw new DesignRefused(
			"brand.warm",
			`role "${c.name}" renders as ${c.hex}, hue ${hue.toFixed(1)} degrees, outside the warm band BRAND.md defaults to. Pass warmOnly: false if this palette is a documented exemption (partner brand, 8gent Games, accessibility mode).`,
		);
	}
}

// ---------------------------------------------------------------------------
// copy.emDash
// ---------------------------------------------------------------------------

/** U+2014 EM DASH and U+2015 HORIZONTAL BAR. BRAND.md: "No em dashes." */
const EM_DASH_RE = /[—―]/;

/**
 * Any string this package emits into copy - token names, descriptions, notes -
 * is checked. The rule is enforced in code because "remember not to" has a
 * hundred per cent failure rate over a long enough run.
 */
export function assertNoEmDash(strings: string[], where: string): void {
	for (const s of strings) {
		if (EM_DASH_RE.test(s)) {
			throw new DesignRefused(
				"copy.emDash",
				`${where} contains an em dash: ${JSON.stringify(s)}. BRAND.md forbids em dashes - use a hyphen or rewrite.`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// a11y.contrast
// ---------------------------------------------------------------------------

/**
 * WCAG 2.2 AA, fail closed. 1.4.3 gives 4.5:1 for body text and 3:1 for large
 * text; 1.4.11 gives 3:1 for non-text boundaries.
 *
 * Deliberately NOT APCA. APCA is not normative anywhere - it was removed from
 * the WCAG 3 draft in July 2023 and the April 2026 Editor's Draft still says
 * the contrast algorithm is "yet to be determined" - and its reference
 * implementation ships under a restricted licence with patents pending. WCAG
 * 2.x is what EN 301 549, Section 508 and the EAA actually point at. Perceptual
 * lightness separation is reported alongside as advisory, and never called
 * contrast.
 */
export function checkContrast(colors: ColorRole[]): ContrastPair[] {
	const by = new Map(colors.map((c) => [c.name, c]));
	const pairs: ContrastPair[] = [];

	for (const req of REQUIRED_PAIRS) {
		const fg = by.get(req.fg);
		const bg = by.get(req.bg);
		if (!fg || !bg) {
			throw new DesignRefused(
				"a11y.contrast",
				`required pair ${req.fg} on ${req.bg} cannot be checked: role missing from the palette`,
			);
		}
		const fgRgb = fromHex(fg.hex);
		const bgRgb = fromHex(bg.hex);
		const ratio = contrastRatio(fgRgb, bgRgb);
		const floor = CONTRAST_FLOOR[req.requirement];
		if (ratio < floor) {
			throw new DesignRefused(
				"a11y.contrast",
				`${req.fg} (${fg.hex}) on ${req.bg} (${bg.hex}) is ${ratio.toFixed(2)}:1, below the WCAG 2.2 AA floor of ${floor}:1 for ${req.requirement}. Refused, not adjusted.`,
			);
		}
		pairs.push({
			fg: req.fg,
			bg: req.bg,
			ratio: Number(ratio.toFixed(3)),
			requirement: req.requirement,
			separation: Number(lightnessSeparation(fgRgb, bgRgb).toFixed(4)),
		});
	}
	return pairs;
}

// ---------------------------------------------------------------------------
// type.monotonic and rhythm.baseline
// ---------------------------------------------------------------------------

/**
 * A quantised geometric ramp at a small ratio collides: 16 * 1.125 = 18, but
 * 12 * 1.125 = 13.5 snapping to 14 while 14 * 1.125 = 15.75 also snapping to
 * 16 is fine, and at the small end the collisions are real. A ramp where two
 * adjacent roles share a size has no hierarchy at all in the size channel, so
 * it is refused rather than shipped and scored badly.
 */
export function assertMonotonicRamp(type: TypeStep[]): void {
	for (let i = 1; i < type.length; i += 1) {
		const bigger = type[i - 1] as TypeStep;
		const smaller = type[i] as TypeStep;
		if (bigger.px <= smaller.px) {
			throw new DesignRefused(
				"type.monotonic",
				`"${bigger.role}" is ${bigger.px}px and "${smaller.role}" is ${smaller.px}px. After pixel quantisation the ramp is not strictly decreasing, so these two roles are typographically indistinguishable. Pick a larger ratio or a larger base.`,
			);
		}
	}
}

/**
 * Vertical rhythm as a hard post-condition: every line box is an exact whole
 * number of baselines. This is the constraint that Wilson Miner's original
 * baseline-grid method reduces to, and the one that mature systems keep even
 * when they abandon modular scales (every Material 3 line height is a multiple
 * of 4; Tailwind stores absolute line heights on a 4px grid).
 */
export function assertBaselineRhythm(type: TypeStep[], baselinePx: number): void {
	for (const step of type) {
		if (step.lineHeightPx % baselinePx !== 0) {
			throw new DesignRefused(
				"rhythm.baseline",
				`"${step.role}" has a ${step.lineHeightPx}px line box, which is not a whole multiple of the ${baselinePx}px baseline. Vertical rhythm would drift.`,
			);
		}
	}
}

/**
 * SC 1.4.12 Text Spacing (AA) requires no loss of content when a user forces
 * line height to 1.5x the font size. A design that ships body text below 1.5
 * has no headroom for that, so 1.5 is the floor for body-sized roles. Display
 * sizes are exempt: SC 1.4.12 is about blocks of text, and a 1.5 line box on a
 * 64px display heading is a layout bug, not an accessibility win.
 */
export function assertTextSpacingHeadroom(type: TypeStep[]): void {
	for (const step of type) {
		if (step.px > 24) continue;
		if (step.lineHeight < 1.5) {
			throw new DesignRefused(
				"a11y.textSpacing",
				`"${step.role}" at ${step.px}px has line-height ${step.lineHeight.toFixed(2)}, below the 1.5 needed for WCAG 2.2 SC 1.4.12 headroom.`,
			);
		}
	}
}

/**
 * Spacing steps must be distinct and increasing. Rounding to whole pixels can
 * collapse two adjacent multipliers at a compact density (0.25 and 0.5 of a
 * 4px unit at 0.75 scale both round to 1px), and a ramp with two identical
 * steps has a token nobody can use for anything.
 */
export function assertSpacingDistinct(space: { name: string; px: number }[]): void {
	for (let i = 1; i < space.length; i += 1) {
		const prev = space[i - 1] as { name: string; px: number };
		const curr = space[i] as { name: string; px: number };
		if (curr.px <= prev.px) {
			throw new DesignRefused(
				"space.distinct",
				`spacing steps "${prev.name}" and "${curr.name}" are both ${curr.px}px after rounding to whole pixels. The ramp has a step that carries no information. Use a larger space unit or a less aggressive density.`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// a11y.target and a11y.measure
// ---------------------------------------------------------------------------

/** SC 2.5.8 Target Size (Minimum), AA: 24 x 24 CSS px. */
export function assertTargetSize(minTargetPx: number): void {
	if (minTargetPx < MIN_TARGET_PX) {
		throw new DesignRefused(
			"a11y.target",
			`minimum interactive target is ${minTargetPx}px, below the ${MIN_TARGET_PX}px floor in WCAG 2.2 SC 2.5.8.`,
		);
	}
}

/** SC 1.4.8 Visual Presentation: no more than 80 characters per line. */
export function assertMeasure(measureCh: number): void {
	if (measureCh > MAX_MEASURE_CH) {
		throw new DesignRefused(
			"a11y.measure",
			`line measure ${measureCh}ch exceeds the ${MAX_MEASURE_CH}ch cap in WCAG 2.2 SC 1.4.8.`,
		);
	}
}

// ---------------------------------------------------------------------------
// motion.reduced
// ---------------------------------------------------------------------------

/**
 * Structural check: every motion token carries a reduced variant, and any token
 * animating a positional property reduces to opacity. The types make the field
 * required; this makes the DERIVATION required, so a future contributor cannot
 * hand-write a token whose reduced variant still moves things around.
 */
export function assertReducedMotion(motion: MotionToken[]): void {
	for (const t of motion) {
		if (!t.reduced) {
			throw new DesignRefused("motion.reduced", `motion token "${t.name}" has no reduced-motion variant.`);
		}
		if ((t.axis === "transform" || t.axis === "size") && t.reduced.axis !== "opacity") {
			throw new DesignRefused(
				"motion.reduced",
				`motion token "${t.name}" animates ${t.axis} but its reduced variant still animates ${t.reduced.axis}. Positional motion must reduce to a cross-fade.`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// The whole gate.
// ---------------------------------------------------------------------------

/**
 * Runs every hard rule against a candidate spec. Returns the verified contrast
 * pairs on success; throws DesignRefused on the first violation.
 *
 * Order matters only for the quality of the error message: brand first, because
 * "you asked for violet" is more useful than "text-secondary on bg-1 is 4.31:1"
 * when both are true.
 */
export function gate(spec: Omit<DesignSpec, "pairs" | "score">): ContrastPair[] {
	assertBrandHue(spec.colors);
	if (spec.intent.warmOnly !== false) assertWarmProfile(spec.colors);
	assertNoEmDash(
		[
			...spec.colors.map((c) => c.name),
			...spec.type.map((t) => t.role),
			...spec.space.map((s) => s.name),
			...spec.motion.map((m) => m.name),
			...spec.motion.map((m) => m.reduced.note),
			spec.layout.css,
			spec.layout.track ?? "",
			spec.intent.product,
			spec.intent.tone ?? "",
		],
		"generated spec",
	);
	assertMonotonicRamp(spec.type);
	assertSpacingDistinct(spec.space);
	assertBaselineRhythm(spec.type, spec.baselinePx);
	assertTextSpacingHeadroom(spec.type);
	assertTargetSize(spec.layout.minTargetPx);
	assertMeasure(spec.layout.measureCh);
	assertReducedMotion(spec.motion);
	return checkContrast(spec.colors);
}
