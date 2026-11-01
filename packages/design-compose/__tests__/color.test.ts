import { describe, expect, test } from "bun:test";
import {
	contrastRatio,
	fromHex,
	gamutMap,
	inSrgbGamut,
	lightnessSeparation,
	relativeLuminance,
	renderedHue,
	rgbToOklch,
	toHex,
} from "../color";

describe("sRGB and Oklab round trip", () => {
	test("hex survives a round trip through OKLCH", () => {
		for (const hex of ["#e8610a", "#0a0908", "#faf7f4", "#22c55e", "#1a1612"]) {
			const back = toHex(gamutMap(rgbToOklch(fromHex(hex))));
			expect(back).toBe(hex);
		}
	});

	test("negative LMS values do not become NaN", () => {
		// The cbrt-versus-pow trap. An out-of-gamut OKLCH triple drives the
		// conversion through negative LMS; Math.pow(x, 1/3) returns NaN there.
		const wild = gamutMap({ l: 0.5, c: 0.4, h: 140 });
		expect(Number.isFinite(wild.r)).toBe(true);
		expect(Number.isFinite(wild.g)).toBe(true);
		expect(Number.isFinite(wild.b)).toBe(true);
	});

	test("gamut mapping holds hue approximately, but NOT exactly", () => {
		// Worth being precise about, because the brand ban leans on it.
		//
		// The binary search in CSS Color 4 reduces chroma at constant lightness
		// AND constant hue. But the value it finally returns is `clipped` - the
		// per-channel clamp of the reduced colour - and clipping is not
		// hue-preserving. Measured drift is up to about 6 degrees at the most
		// out-of-gamut inputs.
		//
		// So "gamut mapping cannot smuggle a colour into the banned band" is
		// ALMOST true and must not be relied on as if it were. That is exactly
		// why LEGAL_HUES is built by measuring the rendered output of gamutMap
		// rather than by reasoning about the algorithm, and why the gate
		// re-checks the rendered pixel.
		let worst = 0;
		for (const h of [20, 60, 140, 220, 300]) {
			const mapped = rgbToOklch(gamutMap({ l: 0.6, c: 0.45, h }));
			worst = Math.max(worst, Math.abs(((mapped.h - h + 540) % 360) - 180));
		}
		expect(worst).toBeGreaterThan(0);
		expect(worst).toBeLessThan(10);
	});

	test("out-of-gamut input is detected, in-gamut is not remapped", () => {
		expect(inSrgbGamut({ l: 0.6, c: 0.45, h: 30 })).toBe(false);
		expect(inSrgbGamut({ l: 0.6, c: 0.02, h: 30 })).toBe(true);
	});
});

describe("WCAG 2.2 contrast", () => {
	test("known anchor values", () => {
		// Black on white is exactly 21:1 by construction.
		expect(contrastRatio(fromHex("#000000"), fromHex("#ffffff"))).toBeCloseTo(21, 5);
		// Identical colours are exactly 1:1.
		expect(contrastRatio(fromHex("#e8610a"), fromHex("#e8610a"))).toBeCloseTo(1, 10);
	});

	test("relative luminance matches the spec's endpoints", () => {
		expect(relativeLuminance(fromHex("#ffffff"))).toBeCloseTo(1, 10);
		expect(relativeLuminance(fromHex("#000000"))).toBeCloseTo(0, 10);
		// Mid grey #808080 has a documented relative luminance near 0.2159.
		expect(relativeLuminance(fromHex("#808080"))).toBeCloseTo(0.2159, 3);
	});

	test("contrast is symmetric", () => {
		const a = fromHex("#12100e");
		const b = fromHex("#f07a28");
		expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
	});
});

describe("renderedHue", () => {
	test("perceptually neutral tints have no hue", () => {
		// The bug the gate caught during the build: a near-white warm tint has
		// an HSL saturation of 100 percent and a hue angle that is rounding
		// noise. Judged perceptually it is a neutral, and it must not be
		// refused as violet.
		expect(renderedHue(fromHex("#fffbfd"))).toBeNull();
		expect(renderedHue(fromHex("#fffdf9"))).toBeNull();
		expect(renderedHue(fromHex("#808080"))).toBeNull();
	});

	test("real colours keep their hue", () => {
		// 8gent's own orange.
		expect(renderedHue(fromHex("#e8610a"))).toBeCloseTo(23.8, 0);
		// A real violet, well above the perceptual chroma floor.
		expect(renderedHue(fromHex("#8a5fc9"))).toBeGreaterThan(255);
	});

	test("the chroma floor cannot hide a saturated colour", () => {
		// Anything a human would call violet is far above the floor. This is
		// the anti-loophole test: the exemption must not be reachable by a
		// colour that actually reads as a hue.
		for (const hex of ["#8a5fc9", "#ad51a7", "#c4496e", "#ff00ff"]) {
			expect(renderedHue(fromHex(hex))).not.toBeNull();
		}
	});
});

describe("lightnessSeparation", () => {
	test("is advisory and ordered, and is never called contrast", () => {
		const bg = fromHex("#0a0908");
		expect(lightnessSeparation(bg, fromHex("#faf7f4"))).toBeGreaterThan(
			lightnessSeparation(bg, fromHex("#5c544a")),
		);
	});
});
