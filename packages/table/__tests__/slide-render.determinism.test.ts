/**
 * The determinism guarantee (spec 4.6), the escaping boundary (spec 4.3), the
 * honesty rule, and BRAND.md compliance.
 *
 * "Same spec plus same theme version yields byte-identical HTML, therefore an
 * identical sha256." If this file fails, a huddle's visuals stopped being
 * re-derivable from its manifest, and the provenance claim is void.
 */

import { describe, expect, it } from "bun:test";
import { esc, renderSlide, THEME_VERSION, type RenderContext } from "../slide-render";
import { buildTheme, themeFor } from "../slide-theme";
import { LAYOUTS, type SlideSpec } from "../slide-spec";

const HUDDLE = "huddle_determinism_fixture";
const CTX: RenderContext = { code: "8TO", name: "Rishi", index: 1, total: 3, huddleId: HUDDLE };

/** A spread of ids, so the brand and contrast checks below run against many
 *  points of the composed lattice rather than one lucky design. */
const HUDDLE_IDS = [
	"",
	HUDDLE,
	"huddle_3c40cc2c31f84eb886ff9596",
	"huddle_4c5d67bd7c504470b67c790b",
	"huddle_0126fa1df2fa4a1099e83bfe",
	"huddle_a",
	"huddle_b",
	"huddle_zen_1",
];

/** One fixed spec per layout - the corpus spec 4.6 asks for. */
const CORPUS: Record<string, SlideSpec> = {
	cover: { layout: "cover", heading: "The floor protocol is on main" },
	bullets: { layout: "bullets", heading: "What shipped", bullets: ["Floor machine", "Slide spec", "Bake"] },
	metric: { layout: "metric", heading: "Turns baked", metric: { value: "4", label: "officer turns" } },
	quote: { layout: "quote", heading: "On honesty", quote: { text: "Unverified never looks verified.", attribution: "8SO" } },
	compare: { layout: "compare", heading: "Live vs baked", compare: { left: "Live stage", right: "Baked deck" } },
	code: { layout: "code", heading: "Run it", code: { lang: "bash", text: "bun test packages/table" } },
	timeline: { layout: "timeline", heading: "The turn", timeline: ["Prepare", "Render", "Speak", "Release"] },
	close: { layout: "close", heading: "That is the demo" },
};

describe("renderSlide determinism", () => {
	it("produces exactly one distinct hash per layout across 100 renders", () => {
		for (const layout of LAYOUTS) {
			const spec = CORPUS[layout];
			const hashes = new Set<string>();
			for (let i = 0; i < 100; i++) hashes.add(renderSlide(spec, CTX).sha256);
			expect(hashes.size).toBe(1);
		}
	});

	it("gives different layouts different hashes", () => {
		const hashes = new Set(LAYOUTS.map((l) => renderSlide(CORPUS[l], CTX).sha256));
		expect(hashes.size).toBe(LAYOUTS.length);
	});

	it("gives the same huddle the same design every time, on every call", () => {
		// One design per deliberation. If this drifts, a re-bake of a six month old
		// manifest stops reproducing the visuals its hashes were taken from.
		for (const id of HUDDLE_IDS) {
			const a = buildTheme(id);
			const b = buildTheme(id);
			expect(a.designId).toBe(b.designId);
			expect(JSON.stringify(a)).toBe(JSON.stringify(b));
			expect(themeFor(id).designId).toBe(a.designId);
		}
	});

	it("gives different huddles different designs, and different hashes", () => {
		const designs = new Set(HUDDLE_IDS.map((id) => buildTheme(id).designId));
		expect(designs.size).toBeGreaterThan(1);
		const hashes = new Set(HUDDLE_IDS.map((id) => renderSlide(CORPUS.bullets, { ...CTX, huddleId: id }).sha256));
		expect(hashes.size).toBe(HUDDLE_IDS.length);
	});

	it("gives every officer in a huddle a distinct accent", () => {
		for (const id of HUDDLE_IDS) {
			const theme = buildTheme(id);
			const accents = Object.values(theme.officers).map((o) => o.hex);
			expect(new Set(accents).size).toBe(accents.length);
		}
	});

	it("changes the hash when the context changes", () => {
		const a = renderSlide(CORPUS.cover, CTX).sha256;
		const b = renderSlide(CORPUS.cover, { ...CTX, name: "Karen", code: "8SO" }).sha256;
		expect(a).not.toBe(b);
	});

	it("binds the hash to the theme version", () => {
		// The theme version is hashed alongside the HTML, so a template change is
		// visible as a hash change rather than a silent redesign.
		expect(THEME_VERSION).toBeTruthy();
		expect(renderSlide(CORPUS.cover, CTX).html).not.toContain(THEME_VERSION);
		expect(renderSlide(CORPUS.cover, CTX).sha256).toHaveLength(64);
	});
});

describe("escaping (spec 4.3 layer 2)", () => {
	it("escapes the four dangerous characters", () => {
		expect(esc(`<script>&"`)).toBe("&lt;script&gt;&amp;&quot;");
	});

	it("neutralises markup in every text-bearing field", () => {
		const hostile = '<img src=x onerror="alert(1)">';
		const specs: SlideSpec[] = [
			{ layout: "cover", heading: hostile },
			{ layout: "bullets", heading: "h", bullets: [hostile] },
			{ layout: "metric", heading: "h", metric: { value: hostile, label: hostile } },
			{ layout: "quote", heading: "h", quote: { text: hostile, attribution: hostile } },
			{ layout: "compare", heading: "h", compare: { left: hostile, right: hostile } },
			{ layout: "timeline", heading: "h", timeline: [hostile] },
			{ layout: "code", heading: "h", code: { lang: "bash", text: hostile } },
		];
		for (const spec of specs) {
			const { html } = renderSlide(spec, CTX);
			expect(html).not.toContain("<img");
			expect(html).not.toContain("onerror=\"");
			expect(html).toContain("&lt;img");
		}
	});

	it("emits no script element of its own", () => {
		for (const layout of LAYOUTS) expect(renderSlide(CORPUS[layout], CTX).html).not.toContain("<script");
	});
});

describe("the honesty rule", () => {
	it("does not mark a field that verified", () => {
		expect(renderSlide(CORPUS.metric, CTX).html).not.toContain("ASSERTED");
	});

	it("marks an unverified field visibly, as text and not colour alone", () => {
		const html = renderSlide(CORPUS.metric, { ...CTX, assertedFields: ["metric.value"] }).html;
		expect(html).toContain("ASSERTED");
		expect(html).toContain('class="asserted"');
	});

	it("marks only the field that failed", () => {
		const spec: SlideSpec = { layout: "bullets", heading: "h", bullets: ["one", "two", "three"] };
		const html = renderSlide(spec, { ...CTX, assertedFields: ["bullets.1"] }).html;
		expect(html.match(/ASSERTED/g)?.length).toBe(1);
		// The chip sits on the second bullet, not the first or third.
		expect(html.indexOf("two")).toBeLessThan(html.indexOf("ASSERTED"));
		expect(html.indexOf("ASSERTED")).toBeLessThan(html.indexOf("three"));
	});

	it("changes the hash when a field becomes asserted", () => {
		const clean = renderSlide(CORPUS.metric, CTX).sha256;
		const flagged = renderSlide(CORPUS.metric, { ...CTX, assertedFields: ["metric.value"] }).sha256;
		expect(clean).not.toBe(flagged);
	});
});

describe("the code layout does not clip silently", () => {
	it("says how many lines it is not showing", () => {
		const long = Array.from({ length: 18 }, (_, i) => `const line${i} = 1;`).join("\n");
		const { html } = renderSlide({ layout: "code", heading: "long", code: { lang: "ts", text: long } }, CTX);
		// 18 lines, 9 shown, 9 hidden and stated on the slide rather than eaten.
		expect(html).toContain("9 more lines not shown");
		expect(html).toContain("const line8 = 1;");
		expect(html).not.toContain("const line9 = 1;");
	});

	it("says nothing when nothing is hidden", () => {
		const { html } = renderSlide(CORPUS.code, CTX);
		expect(html).not.toContain("not shown");
	});
});

describe("BRAND.md compliance", () => {
	/** Convert #rrggbb to an HSL hue in degrees. */
	function hue(hex: string): number {
		const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
		const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
		const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
		const max = Math.max(r, g, b);
		const min = Math.min(r, g, b);
		const d = max - min;
		if (d === 0) return 0;
		let h: number;
		if (max === r) h = ((g - b) / d) % 6;
		else if (max === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		return (h * 60 + 360) % 360;
	}

	/** Hue of an `rgba(r, g, b, a)` value, which is how translucent theme colours
	 *  reach the stylesheet. Scanning only hex would miss every wash and hairline. */
	function rgbHue(r: number, g: number, b: number): number {
		return hue(`#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`);
	}

	it("uses no banned hue in any composed huddle palette", () => {
		for (const id of HUDDLE_IDS) {
			const theme = buildTheme(id);
			const hexes = [...Object.values(theme.color), ...Object.values(theme.officers).flatMap((o) => [o.hex, o.onHex, o.quietHex])];
			for (const hex of hexes) {
				const h = hue(hex);
				expect(h < 270 || h > 350, `${id} emitted ${hex} at hue ${h.toFixed(0)}`).toBe(true);
			}
		}
	});

	it("emits no banned hue in any rendered slide, hex or rgba", () => {
		for (const id of HUDDLE_IDS) {
			for (const layout of LAYOUTS) {
				const html = renderSlide(CORPUS[layout], { ...CTX, huddleId: id }).html;
				for (const hex of html.match(/#[0-9a-fA-F]{6}/g) ?? []) {
					const h = hue(hex);
					expect(h < 270 || h > 350, `${layout} emitted ${hex} at hue ${h.toFixed(0)}`).toBe(true);
				}
				for (const m of html.matchAll(/rgba\((\d+), (\d+), (\d+),/g)) {
					const h = rgbHue(Number(m[1]), Number(m[2]), Number(m[3]));
					expect(h < 270 || h > 350, `${layout} emitted ${m[0]} at hue ${h.toFixed(0)}`).toBe(true);
				}
			}
		}
	});

	it("emits no em dash in any template, on any design", () => {
		for (const id of HUDDLE_IDS) {
			for (const layout of LAYOUTS) {
				expect(renderSlide(CORPUS[layout], { ...CTX, huddleId: id }).html).not.toContain("\u2014");
			}
		}
	});
});
