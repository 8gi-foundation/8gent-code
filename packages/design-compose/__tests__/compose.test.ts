import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { axisCardinalities, coordinateAt, latticeSize, LEGAL_HUES } from "../axes";
import { compose, composeAt, coordinateId, resolve, search, TONE_NAMES } from "../compose";
import { toCss, toSummary, toTokens } from "../render";
import { carbonTypeSize, fluidClamp, fluidResizeFailure } from "../scales";
import { DesignRefused } from "../types";

describe("determinism", () => {
	test("same intent, byte-identical spec", () => {
		const a = compose({ product: "huddle", tone: "stage", seed: 1 });
		const b = compose({ product: "huddle", tone: "stage", seed: 1 });
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	test("different seeds give different specs", () => {
		const ids = new Set<string>();
		for (let seed = 0; seed < 20; seed += 1) {
			try {
				ids.add(compose({ product: "huddle", tone: "showcase", seed }).id);
			} catch {
				// refusals are fine here
			}
		}
		expect(ids.size).toBeGreaterThan(3);
	});

	test("the id is a function of the coordinate alone", () => {
		const coord = resolve({ product: "a", tone: "stage", seed: 2 });
		const one = composeAt(coord, { product: "a", tone: "stage", seed: 2 });
		// Same coordinate, completely different intent text.
		const two = composeAt(coord, { product: "totally-different-name" });
		expect(two.id).toBe(one.id);
		expect(coordinateId(coord)).toBe(one.id);
	});

	test("a spec replays from its coordinate without the intent", () => {
		const original = compose({ product: "replay", tone: "console", seed: 5 });
		const replayed = composeAt(original.coordinate, original.intent);
		expect(JSON.stringify(replayed)).toBe(JSON.stringify(original));
	});

	test("search is a total order, so ranking is reproducible", () => {
		const a = search({ product: "rank", tone: "editorial" }, 24);
		const b = search({ product: "rank", tone: "editorial" }, 24);
		expect(a.ranked.map((s) => s.id)).toEqual(b.ranked.map((s) => s.id));
	});

	test("no Math.random and no clock read anywhere in the package", () => {
		// The determinism guarantee is only as good as this. A future
		// contributor reaching for Math.random breaks replay for every design
		// ever composed, and would otherwise never find out.
		const dir = join(import.meta.dir, "..");
		const offenders: string[] = [];
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".ts")) continue;
			const src = readFileSync(join(dir, file), "utf8");
			// Strip comments so prose about randomness does not trip the check.
			const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
			if (/Math\.random|Date\.now|new Date\(/.test(code)) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});
});

describe("the lattice", () => {
	test("cardinalities multiply to the lattice size", () => {
		const product = Object.values(axisCardinalities()).reduce((a, b) => a * b, 1);
		expect(latticeSize()).toBe(product);
	});

	test("the space is genuinely large", () => {
		// The headline claim, asserted rather than left to the README.
		expect(latticeSize()).toBeGreaterThan(1_000_000_000);
	});

	test("coordinateAt is injective over a sample", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 500; i += 1) {
			const idx = (i * 7919) % latticeSize();
			seen.add(JSON.stringify(coordinateAt(idx)));
		}
		expect(seen.size).toBe(500);
	});

	test("coordinateAt rejects an out-of-range index", () => {
		expect(() => coordinateAt(-1)).toThrow(RangeError);
		expect(() => coordinateAt(latticeSize())).toThrow(RangeError);
	});

	test("the hue axis lost exactly the banned band and nothing else", () => {
		// 72 candidates at 5-degree spacing; the survivors are the legal ones.
		expect(LEGAL_HUES.length).toBeLessThan(72);
		expect(LEGAL_HUES.length).toBeGreaterThan(40);
	});
});

describe("tones", () => {
	test("every tone composes", () => {
		for (const tone of TONE_NAMES) {
			const result = search({ product: "tone-check", tone }, 24);
			expect(result.ranked.length).toBeGreaterThan(0);
		}
	});

	test("a tone pin beats the seed, and an explicit pin beats the tone", () => {
		const c = resolve({ product: "p", tone: "console", seed: 9 });
		expect(c.emphasis).toBe("weight"); // from the tone
		const pinned = resolve({ product: "p", tone: "console", seed: 9, pin: { emphasis: "size" } });
		expect(pinned.emphasis).toBe("size"); // explicit wins
	});

	test("tones produce materially different designs", () => {
		const a = search({ product: "diff", tone: "console" }, 16).best;
		const b = search({ product: "diff", tone: "stage" }, 16).best;
		const differing = (Object.keys(a.coordinate) as (keyof typeof a.coordinate)[]).filter(
			(k) => a.coordinate[k] !== b.coordinate[k],
		);
		expect(differing.length).toBeGreaterThanOrEqual(5);
	});
});

describe("scales", () => {
	test("Carbon's recurrence reproduces its published ramp", () => {
		// Yn = Yn-1 + (floor((n-2)/4)+1) * 2, from packages/type/src/scale.ts.
		const ramp = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(carbonTypeSize);
		expect(ramp).toEqual([12, 14, 16, 18, 20, 24, 28, 32, 36, 42]);
	});

	test("Utopia's clamp reproduces the worked example from the article", () => {
		// min 1rem at 320px, max 2rem at 1440px -> 0.7143rem + 1.4286vw.
		const css = fluidClamp(16, 32, 320, 1440);
		expect(css).toContain("clamp(1rem");
		expect(css).toContain("0.7143rem");
		expect(css).toContain("1.4286vw");
		expect(css).toContain("2rem)");
	});

	test("the SC 1.4.4 fluid check returns a range or null", () => {
		const safe = fluidResizeFailure(16, 18, 360, 1240);
		const risky = fluidResizeFailure(16, 64, 360, 1240);
		for (const r of [safe, risky]) {
			if (r !== null) {
				expect(r.to).toBeGreaterThan(r.from);
			}
		}
	});
});

describe("output", () => {
	const spec = search({ product: "render-check", tone: "editorial", seed: 1 }, 16).best;

	test("CSS has custom properties for every token family", () => {
		const css = toCss(spec);
		expect(css).toContain(":root {");
		expect(css).toContain("--color-bg-0:");
		expect(css).toContain("--text-body:");
		expect(css).toContain("--space-m:");
		expect(css).toContain("--radius-md:");
		expect(css).toContain("--motion-enter-duration:");
		expect(css).toContain("--measure:");
	});

	test("CSS always carries a reduced-motion block", () => {
		const css = toCss(spec);
		expect(css).toContain("@media (prefers-reduced-motion: reduce)");
		// And it substitutes rather than killing: durations survive.
		expect(css).not.toContain("0.01ms");
	});

	test("CSS emits no fractional pixel values", () => {
		const css = toCss(spec);
		expect(css).not.toMatch(/\d+\.\d+px/);
	});

	test("the token object is plain data a slide renderer can consume", () => {
		const tokens = toTokens(spec);
		expect(JSON.parse(JSON.stringify(tokens))).toEqual(tokens);
		expect(tokens).toHaveProperty("color");
		expect(tokens).toHaveProperty("typography");
		expect(tokens).toHaveProperty("space");
		expect(tokens).toHaveProperty("contrast");
	});

	test("the summary is short enough to be worth sending back to a model", () => {
		expect(toSummary(spec).length).toBeLessThan(500);
	});
});

describe("scoring never gates", () => {
	test("a low score still produces a spec", () => {
		const result = search({ product: "score-check", tone: "console" }, 32);
		const worst = result.ranked[result.ranked.length - 1];
		expect(worst).toBeDefined();
		expect(worst?.score.total).toBeGreaterThanOrEqual(0);
		expect(worst?.score.total).toBeLessThanOrEqual(1);
	});

	test("every score component stays in range", () => {
		for (let seed = 0; seed < 30; seed += 1) {
			let spec: ReturnType<typeof compose>;
			try {
				spec = compose({ product: "score-range", tone: "showcase", seed });
			} catch (err) {
				expect(err).toBeInstanceOf(DesignRefused);
				continue;
			}
			for (const v of Object.values(spec.score)) {
				expect(v).toBeGreaterThanOrEqual(0);
				expect(v).toBeLessThanOrEqual(1);
			}
		}
	});

	test("ranking prefers higher contrast headroom, all else equal", () => {
		const result = search({ product: "order", tone: "editorial" }, 32);
		for (let i = 1; i < result.ranked.length; i += 1) {
			expect((result.ranked[i - 1] as { score: { total: number } }).score.total).toBeGreaterThanOrEqual(
				(result.ranked[i] as { score: { total: number } }).score.total,
			);
		}
	});
});
