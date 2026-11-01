/**
 * The wiring between packages/design-compose and the slide renderer.
 *
 * Three properties are load-bearing and each has a test that fails loudly:
 *
 *   1. DETERMINISM. A huddle id composes to exactly one design, forever, on any
 *      machine. Without this a re-bake stops reproducing the visuals whose
 *      hashes are in the manifest, and the provenance rule of 2026-08-03 is void.
 *   2. THE GATE STILL BITES. The design substrate refuses rather than corrects.
 *      A violet officer accent must throw, not quietly become orange. If this
 *      test ever passes by returning a colour, the refusal has been softened
 *      into a warning and BRAND.md is no longer enforced by code.
 *   3. THE CANVAS IS LEGIBLE. The composer builds for a reading surface; a slide
 *      is a poster. The stage ramp has to land inside a band a human can read
 *      from across a room, whichever of the ramp generators the id draws.
 */

import { describe, expect, it } from "bun:test";
import { DesignRefused, WARM_HUES } from "../../design-compose";
import {
	ACCENT_ORDER,
	accentFor,
	buildTheme,
	CANVAS_H,
	huddleDesign,
	markFor,
	solveOfficerAccent,
	themeFor,
} from "../slide-theme";

const IDS = ["", "huddle_a", "huddle_b", "huddle_3c40cc2c31f84eb886ff9596", "huddle_zen_1", "huddle_demo"];

describe("determinism", () => {
	it("maps a huddle id to exactly one design", () => {
		for (const id of IDS) {
			const runs = [buildTheme(id), buildTheme(id), buildTheme(id)];
			const serialised = runs.map((r) => JSON.stringify(r));
			expect(new Set(serialised).size).toBe(1);
		}
	});

	it("memoises without changing the answer", () => {
		for (const id of IDS) expect(JSON.stringify(themeFor(id))).toBe(JSON.stringify(buildTheme(id)));
	});

	it("carries the composed design id, not a name the renderer chose", () => {
		for (const id of IDS) expect(buildTheme(id).designId).toMatch(/^[0-9a-f]{8}$/);
	});

	it("walks past refusals rather than failing, and says how many", () => {
		for (const id of IDS) {
			const { spec, skipped } = huddleDesign(id);
			expect(spec.coordinate).toBeDefined();
			expect(skipped).toBeGreaterThanOrEqual(0);
			expect(buildTheme(id).summary).toContain("refused before this one");
		}
	});
});

describe("the constraint gate still bites", () => {
	it("REFUSES a violet officer accent instead of correcting it", () => {
		const base = buildTheme("huddle_a");
		const colors = huddleDesign("huddle_a").spec.colors;
		// OKLCH 320 renders as #c075d2 at 288 degrees: violet to anyone looking at
		// it, and inside BRAND.md's banned band. There is no coordinate that
		// reaches it, so this is the hand-written-override path the gate exists for.
		let refusal: DesignRefused | null = null;
		try {
			solveOfficerAccent("8XX", 320, "bright", base.polarity, base.color.bg2, colors);
		} catch (err) {
			refusal = err as DesignRefused;
		}
		expect(refusal).toBeInstanceOf(DesignRefused);
		expect(refusal?.rule).toBe("brand.hue");
		expect(refusal?.message).toContain("270-350");
		// And it threw rather than returning a corrected colour. That distinction
		// is the whole point: a silently orange-ified violet teaches nobody that
		// the intent was wrong.
		expect(refusal?.message).toContain("Not corrected");
	});

	it("refuses OKLCH 300 too, but on brand.warm - the documented BRAND.md gap", () => {
		// design-compose's README records this and recommends widening the band's
		// lower bound to 255. OKLCH 300 renders at 263 degrees, which is below 270,
		// so brand.hue does NOT fire on it. Under the warm profile (the default,
		// and what a huddle uses) brand.warm catches it anyway. The test states the
		// gap rather than papering over it: if BRAND.md is ever widened to 255 this
		// assertion is what will need updating, and it will be obvious why.
		const base = buildTheme("huddle_a");
		const colors = huddleDesign("huddle_a").spec.colors;
		let refusal: DesignRefused | null = null;
		try {
			solveOfficerAccent("8XX", 300, "bright", base.polarity, base.color.bg2, colors);
		} catch (err) {
			refusal = err as DesignRefused;
		}
		expect(refusal?.rule).toBe("brand.warm");
	});

	it("leaves no hue between 255 and 360 admissible", () => {
		const base = buildTheme("huddle_a");
		const colors = huddleDesign("huddle_a").spec.colors;
		for (let hue = 255; hue <= 360; hue += 5) {
			expect(() => solveOfficerAccent("8XX", hue, "bright", base.polarity, base.color.bg2, colors)).toThrow(
				DesignRefused,
			);
		}
	});

	it("refuses a cool accent under the warm profile", () => {
		const base = buildTheme("huddle_a");
		const colors = huddleDesign("huddle_a").spec.colors;
		// 220 is a cornflower blue: legal under brand.hue, outside the warm band.
		// Two rule ids, so a refusal says which rule bit.
		expect(() => solveOfficerAccent("8XX", 220, "bright", base.polarity, base.color.bg2, colors)).toThrow(
			/brand\.warm|a11y\.contrast/,
		);
	});

	it("admits every hue the warm axis actually offers", () => {
		const base = buildTheme("huddle_a");
		const colors = huddleDesign("huddle_a").spec.colors;
		for (const hue of WARM_HUES) {
			for (const rung of ["bright", "deep"] as const) {
				expect(() => solveOfficerAccent("8XX", hue, rung, base.polarity, base.color.bg2, colors)).not.toThrow();
			}
		}
	});
});

describe("officer identity", () => {
	it("gives every officer on the roster an accent", () => {
		const theme = buildTheme("huddle_a");
		for (const code of ACCENT_ORDER) expect(theme.officers[code]).toBeDefined();
	});

	it("never repeats an accent inside one huddle", () => {
		for (const id of IDS) {
			const hexes = Object.values(buildTheme(id).officers).map((o) => o.hex);
			expect(new Set(hexes).size).toBe(hexes.length);
		}
	});

	it("alternates the lightness rung so neighbours in the roster differ twice over", () => {
		const theme = buildTheme("huddle_a");
		const rungs = ACCENT_ORDER.map((c) => theme.officers[c]?.rung);
		for (let i = 1; i < rungs.length; i += 1) expect(rungs[i]).not.toBe(rungs[i - 1]);
	});

	it("marks an officer by their code, and a human by an initial", () => {
		expect(markFor("8TO")).toBe("TO");
		expect(markFor("8DO")).toBe("DO");
		expect(markFor("HUMAN")).toBe("H");
	});

	it("falls back to the exec accent for a code that is not on the roster", () => {
		const theme = buildTheme("huddle_a");
		expect(accentFor(theme, "8ZZ").hex).toBe(theme.officers["8EO"]?.hex);
		expect(accentFor(theme, "8to").hex).toBe(theme.officers["8TO"]?.hex);
	});

	it("reads the officer's brief off the roster rather than restating it", () => {
		expect(buildTheme("huddle_a").officers["8DO"]?.role).toBe("design");
		expect(buildTheme("huddle_a").officers["8SO"]?.role).toBe("security");
	});
});

describe("the stage ramp fits the canvas", () => {
	it("keeps every role inside a legible band at 1920 by 1080", () => {
		for (const id of IDS) {
			const t = buildTheme(id);
			// The smallest role on the slide. Below ~24px a 1920 canvas played back
			// at half size in the stage pane stops being readable.
			expect(t.type.sub.px).toBeGreaterThanOrEqual(24);
			// The largest. A hero taller than a quarter of the canvas collides with
			// the officer band above it.
			expect(t.type.hero.px).toBeLessThanOrEqual(Math.round(CANVAS_H * 0.25));
			expect(t.type.hero.px).toBeGreaterThan(t.type.cover.px);
			expect(t.type.cover.px).toBeGreaterThan(t.type.title.px);
			expect(t.type.title.px).toBeGreaterThan(t.type.lead.px);
			expect(t.type.lead.px).toBeGreaterThan(t.type.sub.px);
		}
	});

	it("keeps every line box a whole number of baselines", () => {
		for (const id of IDS) {
			const t = buildTheme(id);
			for (const step of Object.values(t.type)) {
				expect(step.lineHeightPx % t.baselinePx).toBe(0);
			}
		}
	});

	it("leaves room to compose on: margins under a fifth of the canvas", () => {
		for (const id of IDS) {
			const t = buildTheme(id);
			expect(t.pad.x).toBeGreaterThan(0);
			expect(t.pad.x * 2).toBeLessThan(1920 * 0.2);
			expect(t.pad.top + t.pad.bottom).toBeLessThan(CANVAS_H * 0.3);
		}
	});
});

describe("no forbidden source of nondeterminism", () => {
	it("has no clock read and no random source in the bridge", async () => {
		// The same scan design-compose runs over itself. A memo is a cache of a
		// pure function; a clock read is not.
		const src = await Bun.file(new URL("../slide-theme.ts", import.meta.url)).text();
		const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		expect(code).not.toContain("Math.random");
		expect(code).not.toContain("Date.now");
		expect(code).not.toContain("performance.now");
		expect(code).not.toContain("toLocaleString");
	});
});
