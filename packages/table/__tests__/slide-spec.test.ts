/**
 * SlideSpec parsing, validation, shape normalization and fallback.
 *
 * The fixtures marked REAL are verbatim shapes emitted by the officers' actual
 * model (gemma-4-12b-coder-fable5-composer2.5-v1) during the Phase 1 demo run.
 * Every one of them was REJECTED by the first implementation. They are kept
 * here so a future change that re-breaks them fails loudly.
 */

import { describe, expect, it } from "bun:test";
import {
	LIMITS,
	fallbackSpecFromText,
	findSlideMarker,
	hasSlideMarker,
	normalizeSpecShape,
	resolveSlide,
	stripSlideMarker,
	validateSlideSpec,
} from "../slide-spec";

const marker = (json: string) => `Some spoken prose.\n\n[[SLIDE ${json}]]`;

describe("findSlideMarker", () => {
	it("finds a well-formed marker and its JSON body", () => {
		const found = findSlideMarker(marker('{"layout":"cover","heading":"Hi"}'));
		expect(found?.json).toBe('{"layout":"cover","heading":"Hi"}');
	});

	it("returns null when there is no marker at all", () => {
		expect(findSlideMarker("just prose")).toBeNull();
		expect(hasSlideMarker("just prose")).toBe(false);
	});

	it("does not terminate early on a ]] inside a JSON string (REAL: nested claim)", () => {
		const found = findSlideMarker(
			marker('{"layout":"metric","heading":"H","metric":{"value":"[[CLAIM src=git.head repo=/r]]","label":"L"}}'),
		);
		expect(found?.json).toContain("[[CLAIM src=git.head repo=/r]]");
		expect(JSON.parse(found?.json ?? "{}").metric.value).toBe("[[CLAIM src=git.head repo=/r]]");
	});

	it("salvages an unterminated marker by closing what is open", () => {
		const found = findSlideMarker('prose\n\n[[SLIDE {"layout":"bullets","heading":"Missing","bullets":["a","b"');
		expect(() => JSON.parse(found?.json ?? "")).not.toThrow();
		expect(JSON.parse(found?.json ?? "{}").bullets).toEqual(["a", "b"]);
	});

	it("salvages a dangling key with no value", () => {
		const found = findSlideMarker('p\n\n[[SLIDE {"layout":"cover","heading":"H","bullets":');
		expect(JSON.parse(found?.json ?? "{}")).toEqual({ layout: "cover", heading: "H" });
	});
});

describe("stripSlideMarker", () => {
	it("leaves only the speakable prose", () => {
		expect(stripSlideMarker(marker('{"layout":"cover","heading":"Hi"}'))).toBe("Some spoken prose.");
	});

	it("swallows over-closed bracket residue (REAL: 8PO emitted }}])", () => {
		const reply = 'Spoken line.\n\n[[SLIDE {"layout":"bullets","heading":"H","bullets":["a"]}}]';
		expect(stripSlideMarker(reply)).toBe("Spoken line.");
	});

	it("removes an unterminated marker rather than reading JSON aloud", () => {
		const speech = stripSlideMarker('Spoken line.\n\n[[SLIDE {"layout":"bullets","heading":"X","bullets":["a"');
		expect(speech).toBe("Spoken line.");
		expect(speech).not.toContain("layout");
	});
});

describe("normalizeSpecShape", () => {
	it("lifts a flattened compare payload (REAL)", () => {
		const out = normalizeSpecShape({ layout: "compare", heading: "H", left: "A", right: "B" });
		expect(out).toEqual({ layout: "compare", heading: "H", compare: { left: "A", right: "B" } });
	});

	it("lifts a flattened metric payload (REAL)", () => {
		const out = normalizeSpecShape({ layout: "metric", heading: "H", value: "4", label: "turns" });
		expect(out.metric).toEqual({ value: "4", label: "turns" });
	});

	it("never overwrites a correctly nested payload", () => {
		const out = normalizeSpecShape({ layout: "metric", heading: "H", metric: { value: "1", label: "x" }, value: "9" });
		expect(out.metric).toEqual({ value: "1", label: "x" });
	});

	it("does not lift a payload the layout did not ask for", () => {
		const out = normalizeSpecShape({ layout: "bullets", heading: "H", left: "A", right: "B" });
		expect(out.compare).toBeUndefined();
		expect(out.left).toBe("A"); // still unknown, so validation still rejects it
	});

	it("folds a REAL nested two-column compare down to the closed schema", () => {
		// Verbatim shape from 8TO on "what is missing before it ships". The model
		// nests a heading and bullets per side and omits the top-level heading.
		const r = resolveSlide(
			'p\n\n[[SLIDE {"layout":"compare","left":{"heading":"In Scope","bullets":["Ledger head defined"]},' +
				'"right":{"heading":"Missing to Ship","bullets":["Production hardening"]}}]]',
		);
		expect(r.source).toBe("marker");
		expect(r.spec.compare).toEqual({ left: "In Scope", right: "Missing to Ship" });
		expect(r.spec.heading).toBe("In Scope vs Missing to Ship");
	});

	it("derives a heading rather than throwing away an otherwise good slide", () => {
		const r = resolveSlide('p\n\n[[SLIDE {"layout":"bullets","bullets":["First real point","Second real point"]}]]');
		expect(r.source).toBe("marker");
		expect(r.spec.heading).toBe("First real point");
	});

	it("maps list synonyms onto the layout's own list field", () => {
		expect(normalizeSpecShape({ layout: "bullets", heading: "H", items: ["a"] }).bullets).toEqual(["a"]);
		expect(normalizeSpecShape({ layout: "timeline", heading: "H", steps: ["a"] }).timeline).toEqual(["a"]);
	});
});

describe("validateSlideSpec", () => {
	it("accepts a minimal cover slide", () => {
		expect(validateSlideSpec({ layout: "cover", heading: "Hello" })).toMatchObject({ ok: true });
	});

	it("rejects an unknown layout", () => {
		expect(validateSlideSpec({ layout: "carousel", heading: "H" }).ok).toBe(false);
	});

	it("rejects an unknown key that is not a known flattening", () => {
		const r = validateSlideSpec({ layout: "cover", heading: "H", onclick: "alert(1)" });
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("onclick");
	});

	it("rejects a layout missing the payload it exists to show", () => {
		expect(validateSlideSpec({ layout: "metric", heading: "H" }).ok).toBe(false);
		expect(validateSlideSpec({ layout: "quote", heading: "H" }).ok).toBe(false);
	});

	it("rejects a non-string where a string is required", () => {
		expect(validateSlideSpec({ layout: "cover", heading: 42 }).ok).toBe(false);
		expect(validateSlideSpec({ layout: "cover", heading: "" }).ok).toBe(false);
	});

	it("clips an oversize string instead of losing the whole slide", () => {
		const r = validateSlideSpec({ layout: "bullets", heading: "H", bullets: ["a".repeat(70)] });
		expect(r.ok).toBe(true);
		expect(r.spec?.bullets?.[0].length).toBeLessThanOrEqual(LIMITS.bulletChars);
	});

	it("exempts a claim REFERENCE from the resolved value's cap", () => {
		const r = validateSlideSpec({
			layout: "metric",
			heading: "H",
			metric: { value: "[[CLAIM src=git.head repo=/some/long/path]]", label: "head" },
		});
		expect(r.ok).toBe(true);
		expect(r.spec?.metric?.value).toContain("[[CLAIM");
	});

	it("truncates an over-long list rather than rejecting it", () => {
		const r = validateSlideSpec({ layout: "bullets", heading: "H", bullets: ["a", "b", "c", "d", "e", "f", "g"] });
		expect(r.ok).toBe(true);
		expect(r.spec?.bullets?.length).toBe(LIMITS.bullets);
	});

	it("accepts a single bullet given as a bare string", () => {
		expect(validateSlideSpec({ layout: "bullets", heading: "H", bullets: "only one" }).spec?.bullets).toEqual(["only one"]);
	});

	it("rejects a code lang outside the enum", () => {
		expect(validateSlideSpec({ layout: "code", heading: "H", code: { lang: "rb", text: "x" } }).ok).toBe(false);
	});
});

describe("repairJson (REAL malformed output from the officers' 12B model)", () => {
	/** Each fixture is verbatim from a real huddle turn. All were rejected
	 *  before the repair pass existed, and all carried good content. */
	const REAL: [string, string][] = [
		[
			"doubled opening quote in an array",
			'[[SLIDE {"layout":"bullets","heading":"Backend readiness","bullets":["Ledger committed",""File count matches"]}}}',
		],
		[
			"over-closed braces",
			'[[SLIDE {"layout":"bullets","heading":"Demo Readiness Check","bullets":["Verify ledger head","Validate branch"]}}}]]',
		],
		[
			"payload appended after the object closed",
			'[[SLIDE {"layout":"bullets","heading":"Ledger Core Ready","bullets":["File structure committed"]},"metric":{"value":"x"}]]]',
		],
		["trailing commas", '[[SLIDE {"layout":"bullets","heading":"H","bullets":["a","b",],}]]'],
		["single quotes", "[[SLIDE {'layout':'cover','heading':'Single quoted'}]]"],
		["missing comma between pairs", '[[SLIDE {"layout":"cover" "heading":"No comma"}]]'],
	];

	for (const [name, raw] of REAL) {
		it(`recovers a slide from: ${name}`, () => {
			const r = resolveSlide(`Spoken line.\n\n${raw}`);
			expect(r.source, r.rejectedReason ?? "").toBe("marker");
			expect(r.spec.heading.length).toBeGreaterThan(0);
			expect(r.speech).toBe("Spoken line.");
		});
	}

	it("repair can never smuggle an invalid slide past the validator", () => {
		// Repaired into valid JSON, but still not a valid spec.
		const r = resolveSlide('p\n\n[[SLIDE {"layout":"cover","heading":"H","evil":"x",}]]');
		expect(r.source).toBe("fallback");
		expect(r.rejectedReason).toContain("evil");
	});
});

describe("fallbackSpecFromText", () => {
	it("is a pure function of the text", () => {
		const text = "First sentence. Second one. Third one. Fourth one.";
		expect(fallbackSpecFromText(text)).toEqual(fallbackSpecFromText(text));
	});

	it("uses the first sentence as the heading and the next three as bullets", () => {
		const spec = fallbackSpecFromText("Alpha. Beta. Gamma. Delta. Epsilon.");
		expect(spec.heading).toBe("Alpha.");
		expect(spec.bullets).toEqual(["Beta.", "Gamma.", "Delta."]);
	});

	it("degrades to a cover slide when there is only one sentence", () => {
		expect(fallbackSpecFromText("Only this.").layout).toBe("cover");
	});
});

describe("resolveSlide", () => {
	it("never throws and never returns an error slide", () => {
		for (const reply of ["", "prose only", "[[SLIDE not json]]", "[[SLIDE {", "[[SLIDE {}]]", "[[SLIDE null]]"]) {
			const r = resolveSlide(reply);
			expect(r.spec.heading.length).toBeGreaterThan(0);
			expect(r.spec.layout).toBeTruthy();
		}
	});

	it("falls back to the officer's own prose when the marker is unusable", () => {
		const r = resolveSlide("The gate is closed. It holds under load.\n\n[[SLIDE {\"layout\":\"nope\"}]]");
		expect(r.source).toBe("fallback");
		expect(r.rejectedReason).toBeTruthy();
		expect(r.spec.heading).toBe("The gate is closed.");
	});

	it("uses the officer's own spec when it is valid", () => {
		const r = resolveSlide(marker('{"layout":"cover","heading":"Real heading"}'));
		expect(r.source).toBe("marker");
		expect(r.spec.heading).toBe("Real heading");
	});
});
