/**
 * The refusal tests.
 *
 * These are the equivalent of the planted-lie test in packages/verify. Each one
 * constructs something that violates a rule and asserts that it is REFUSED, not
 * corrected, not warned about, not scored badly. A test that merely checked the
 * happy path would tell us nothing about whether the gate exists.
 */

import { describe, expect, test } from "bun:test";
import { BANNED_HUE_MAX, BANNED_HUE_MIN, LEGAL_HUES, WARM_HUES } from "../axes";
import { fromHex, gamutMap, renderedHue, toHex } from "../color";
import { compose, composeAt, resolve, search } from "../compose";
import {
	assertBaselineRhythm,
	assertBrandHue,
	assertMeasure,
	assertMonotonicRamp,
	assertNoEmDash,
	assertReducedMotion,
	assertSpacingDistinct,
	assertTargetSize,
	assertTextSpacingHeadroom,
	assertWarmProfile,
	checkContrast,
} from "../constraints";
import { DesignRefused } from "../types";
import type { ColorRole, MotionToken, TypeStep } from "../types";

function role(name: string, hex: string): ColorRole {
	const rgb = fromHex(hex);
	return { name, hex, oklch: { l: 0, c: 0, h: 0 }, renderedHue: renderedHue(rgb) };
}

function step(role: string, px: number, lineHeightPx: number): TypeStep {
	return {
		role,
		px,
		lineHeightPx,
		lineHeight: lineHeightPx / px,
		weight: 400,
		tracking: 0,
		fluid: null,
	};
}

describe("brand.hue is unspoofable", () => {
	test("a violet role is refused, whatever it claims about itself", () => {
		// The role lies: its own renderedHue field says null. The gate recomputes
		// from the hex, so the lie does not help.
		const liar: ColorRole = {
			name: "accent",
			hex: "#ad51a7",
			oklch: { l: 0.5, c: 0.16, h: 30 },
			renderedHue: null,
		};
		expect(() => assertBrandHue([liar])).toThrow(DesignRefused);
		try {
			assertBrandHue([liar]);
		} catch (err) {
			expect((err as DesignRefused).rule).toBe("brand.hue");
		}
	});

	test("every hue inside the banned band is refused", () => {
		for (let h = BANNED_HUE_MIN; h <= BANNED_HUE_MAX; h += 5) {
			// Build a colour whose RENDERED hue is h, not one whose OKLCH hue is h.
			const hex = toHex(hslToRgbApprox(h));
			expect(() => assertBrandHue([role("accent", hex)])).toThrow(DesignRefused);
		}
	});

	test("orange and green are not refused", () => {
		expect(() => assertBrandHue([role("accent", "#e8610a")])).not.toThrow();
		expect(() => assertBrandHue([role("accent", "#22c55e")])).not.toThrow();
	});

	test("the hue axis contains no banned hue at any lightness", () => {
		// Belt: the axis itself. There is no integer a caller can pass that
		// reaches violet, so the refusal above is defence in depth.
		for (const h of LEGAL_HUES) {
			for (const l of [0.3, 0.45, 0.6, 0.75, 0.9]) {
				const hue = renderedHue(gamutMap({ l, c: 0.16, h }));
				if (hue === null) continue;
				expect(hue >= BANNED_HUE_MIN && hue <= BANNED_HUE_MAX).toBe(false);
			}
		}
	});

	test("no composed design in a broad sweep contains a banned hue", () => {
		// End to end. 200 real designs, every colour role checked.
		let checked = 0;
		for (let seed = 0; seed < 200; seed += 1) {
			let spec: ReturnType<typeof compose>;
			try {
				spec = compose({ product: "sweep", tone: "showcase", seed });
			} catch {
				continue;
			}
			for (const c of spec.colors) {
				const hue = c.renderedHue;
				if (hue === null) continue;
				expect(hue >= BANNED_HUE_MIN && hue <= BANNED_HUE_MAX).toBe(false);
				checked += 1;
			}
		}
		expect(checked).toBeGreaterThan(100);
	});
});

/** Build an sRGB colour at a given HSL hue, full saturation, mid lightness. */
function hslToRgbApprox(h: number): { r: number; g: number; b: number } {
	const c = 0.6;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = 0.2;
	let rgb: [number, number, number];
	if (h < 60) rgb = [c, x, 0];
	else if (h < 120) rgb = [x, c, 0];
	else if (h < 180) rgb = [0, c, x];
	else if (h < 240) rgb = [0, x, c];
	else if (h < 300) rgb = [x, 0, c];
	else rgb = [c, 0, x];
	return { r: rgb[0] + m, g: rgb[1] + m, b: rgb[2] + m };
}

describe("brand.warm", () => {
	test("a blue secondary is refused under the default profile", () => {
		expect(() => assertWarmProfile([role("secondary", "#3772b9")])).toThrow(DesignRefused);
	});

	test("warm hues pass", () => {
		for (const hex of ["#e8610a", "#f07a28", "#d55954", "#b25900"]) {
			expect(() => assertWarmProfile([role("accent", hex)])).not.toThrow();
		}
	});

	test("the warm axis is a strict subset of the legal axis", () => {
		expect(WARM_HUES.length).toBeGreaterThan(0);
		expect(WARM_HUES.length).toBeLessThan(LEGAL_HUES.length);
		for (const h of WARM_HUES) expect(LEGAL_HUES).toContain(h);
	});

	test("no design composed under the warm profile is ever refused for being unwarm", () => {
		// Regression. The warm axis was originally filtered by probing ONE
		// lightness, so a boundary hue passed at 0.68 and its own accent-quiet
		// role - built at a different lightness - rendered at 75.6 degrees and
		// was refused. The axis and the rule have to agree at every lightness
		// and chroma a role can actually reach, or the composer refuses designs
		// it explicitly told itself were legal.
		const unwarm: string[] = [];
		for (let seed = 0; seed < 120; seed += 1) {
			for (const tone of ["editorial", "console", "stage", "showcase", "utility"]) {
				try {
					compose({ product: "warm-regression", tone, seed });
				} catch (err) {
					if (err instanceof DesignRefused && err.rule === "brand.warm") unwarm.push(err.detail);
				}
			}
		}
		expect(unwarm).toEqual([]);
	});

	test("warmOnly false lets a documented exemption through", () => {
		// 8gent Games ships neon green, explicitly exempted in BRAND.md.
		const spec = compose({ product: "games", tone: "showcase", warmOnly: false, seed: 3 });
		expect(spec.colors.length).toBeGreaterThan(0);
	});
});

describe("copy.emDash", () => {
	test("an em dash is refused", () => {
		expect(() => assertNoEmDash(["a — b"], "test")).toThrow(DesignRefused);
		expect(() => assertNoEmDash(["a ― b"], "test")).toThrow(DesignRefused);
	});

	test("a hyphen is fine", () => {
		expect(() => assertNoEmDash(["a - b", "size-weight", "bg-0"], "test")).not.toThrow();
	});

	test("no composed design emits an em dash anywhere", () => {
		for (let seed = 0; seed < 40; seed += 1) {
			let spec: ReturnType<typeof compose>;
			try {
				spec = compose({ product: "copy-sweep", tone: "editorial", seed });
			} catch {
				continue;
			}
			expect(JSON.stringify(spec)).not.toMatch(/[—―]/);
		}
	});
});

describe("a11y.contrast fails closed", () => {
	test("a failing pair is refused, not adjusted", () => {
		const colors = [
			role("bg-0", "#0a0908"),
			role("bg-1", "#0c0b0a"),
			role("bg-2", "#0e0d0c"),
			// Deliberately far too dark to read on any of those.
			role("text-primary", "#1a1918"),
			role("text-secondary", "#1a1918"),
			role("text-tertiary", "#1a1918"),
			role("accent", "#1a1918"),
			role("on-accent", "#1a1918"),
			role("border", "#1a1918"),
		];
		expect(() => checkContrast(colors)).toThrow(DesignRefused);
		try {
			checkContrast(colors);
		} catch (err) {
			expect((err as DesignRefused).rule).toBe("a11y.contrast");
			// The refusal names the measured value. A refusal that did not would
			// be an assertion, not evidence.
			expect((err as DesignRefused).detail).toMatch(/:1, below the WCAG 2\.2 AA floor/);
		}
	});

	test("a missing role is refused rather than skipped", () => {
		expect(() => checkContrast([role("bg-0", "#000000")])).toThrow(DesignRefused);
	});

	test("every composed design clears its floors", () => {
		const floors = { body: 4.5, large: 3.0, nonText: 3.0 } as const;
		let checked = 0;
		for (let seed = 0; seed < 60; seed += 1) {
			for (const tone of ["editorial", "console", "stage", "showcase", "utility"]) {
				let spec: ReturnType<typeof compose>;
				try {
					spec = compose({ product: "contrast-sweep", tone, seed });
				} catch {
					continue;
				}
				for (const p of spec.pairs) {
					expect(p.ratio).toBeGreaterThanOrEqual(floors[p.requirement]);
					checked += 1;
				}
			}
		}
		expect(checked).toBeGreaterThan(500);
	});
});

describe("type and rhythm", () => {
	test("a colliding ramp is refused", () => {
		expect(() => assertMonotonicRamp([step("body", 14, 21), step("caption", 14, 21)])).toThrow(
			DesignRefused,
		);
	});

	test("an inverted ramp is refused", () => {
		expect(() => assertMonotonicRamp([step("h1", 12, 18), step("body", 16, 24)])).toThrow(
			DesignRefused,
		);
	});

	test("a line box off the baseline is refused", () => {
		expect(() => assertBaselineRhythm([step("body", 16, 25)], 8)).toThrow(DesignRefused);
		expect(() => assertBaselineRhythm([step("body", 16, 24)], 8)).not.toThrow();
	});

	test("body text below 1.5 line-height is refused", () => {
		expect(() => assertTextSpacingHeadroom([step("body", 16, 20)])).toThrow(DesignRefused);
		// Display sizes are exempt: SC 1.4.12 is about blocks of text.
		expect(() => assertTextSpacingHeadroom([step("display", 64, 70)])).not.toThrow();
	});

	test("colliding spacing steps are refused", () => {
		expect(() =>
			assertSpacingDistinct([
				{ name: "2xs", px: 2 },
				{ name: "xs", px: 2 },
			]),
		).toThrow(DesignRefused);
	});

	test("every composed ramp is monotonic and on the baseline", () => {
		for (let seed = 0; seed < 60; seed += 1) {
			let spec: ReturnType<typeof compose>;
			try {
				spec = compose({ product: "ramp-sweep", tone: "stage", seed });
			} catch {
				continue;
			}
			for (let i = 1; i < spec.type.length; i += 1) {
				expect((spec.type[i - 1] as TypeStep).px).toBeGreaterThan((spec.type[i] as TypeStep).px);
			}
			for (const t of spec.type) expect(t.lineHeightPx % spec.baselinePx).toBe(0);
		}
	});
});

describe("a11y.target and a11y.measure", () => {
	test("a target below 24px is refused", () => {
		expect(() => assertTargetSize(23)).toThrow(DesignRefused);
		expect(() => assertTargetSize(24)).not.toThrow();
	});

	test("a measure above 80ch is refused", () => {
		expect(() => assertMeasure(81)).toThrow(DesignRefused);
		expect(() => assertMeasure(80)).not.toThrow();
	});
});

describe("motion.reduced cannot be forgotten", () => {
	test("a positional token that does not reduce to a cross-fade is refused", () => {
		const bad: MotionToken = {
			name: "slide",
			durationMs: 200,
			easing: [0, 0, 1, 1],
			spring: null,
			axis: "transform",
			reduced: { durationMs: 200, axis: "colour", note: "wrong" },
		};
		expect(() => assertReducedMotion([bad])).toThrow(DesignRefused);
	});

	test("every composed motion token carries a correct reduced variant", () => {
		for (const tone of ["editorial", "showcase", "stage"]) {
			const spec = search({ product: "motion-sweep", tone }, 8).best;
			for (const m of spec.motion) {
				expect(m.reduced).toBeDefined();
				if (m.axis === "transform" || m.axis === "size") expect(m.reduced.axis).toBe("opacity");
				else expect(m.reduced.axis).toBe(m.axis);
			}
		}
	});
});

describe("refusals are thrown, never returned as a corrected value", () => {
	test("a pinned magenta accent never yields a spec", () => {
		let emitted: unknown = null;
		try {
			emitted = compose({
				product: "violation",
				tone: "editorial",
				pin: { accentHue: 330, structure: "mono" },
				warmOnly: false,
			});
		} catch (err) {
			expect(err).toBeInstanceOf(DesignRefused);
		}
		expect(emitted).toBeNull();
	});

	test("a search where everything is refused throws rather than returning a fallback", () => {
		expect(() =>
			search(
				{
					product: "impossible",
					tone: "editorial",
					pin: { accentHue: 330, structure: "mono" },
					warmOnly: false,
				},
				8,
			),
		).toThrow(DesignRefused);
	});

	test("an unknown tone is refused rather than defaulted", () => {
		expect(() => resolve({ product: "x", tone: "vibey" })).toThrow(DesignRefused);
	});
});
