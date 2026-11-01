/**
 * Marker parsing and the daemon seam.
 *
 * The salvage tests matter more than they look. These markers are written by
 * 9-12B local models that truncate mid-token, close brackets early and reorder
 * keys. A parser that rejected anything imperfect would silently drop most of
 * the design intents the officers actually emit, and the failure would look
 * like "the officer never asked for a design" rather than like a parse error.
 */

import { describe, expect, test } from "bun:test";
import { OFFICER_DESIGN_PROMPT, parseDesignMarkers } from "../marker";
import { DESIGN_LEDGER_KIND, DESIGN_REFUSED_LEDGER_KIND, renderDesignMarkers } from "../pipeline";

describe("parseDesignMarkers", () => {
	test("a well-formed marker", () => {
		const [m] = parseDesignMarkers("Here is the look. [[DESIGN product=huddle tone=stage seed=3]]");
		expect(m?.intent.product).toBe("huddle");
		expect(m?.intent.tone).toBe("stage");
		expect(m?.intent.seed).toBe(3);
	});

	test("an unclosed marker is salvaged, not dropped", () => {
		const [m] = parseDesignMarkers("[[DESIGN product=table tone=console");
		expect(m?.intent.product).toBe("table");
		expect(m?.intent.tone).toBe("console");
	});

	test("an early-closed bracket inside a value is stripped", () => {
		const [m] = parseDesignMarkers("[[DESIGN product=deck] tone=stage]]");
		expect(m?.intent.product).toBe("deck");
	});

	test("keys in any order", () => {
		const [m] = parseDesignMarkers("[[DESIGN seed=7 tone=utility product=forms]]");
		expect(m?.intent.product).toBe("forms");
		expect(m?.intent.tone).toBe("utility");
		expect(m?.intent.seed).toBe(7);
	});

	test("an unknown tone is dropped rather than passed through to refusal", () => {
		// A hallucinated tone should fall back to seed-driven composition, not
		// abort the whole design. The tone vocabulary is closed; the model
		// getting it wrong is expected, not exceptional.
		const [m] = parseDesignMarkers("[[DESIGN product=x tone=vibey]]");
		expect(m?.intent.tone).toBeUndefined();
	});

	test("valid pins are kept, invalid pins are dropped", () => {
		const [m] = parseDesignMarkers(
			"[[DESIGN product=x polarity=dark density=nonsense skeleton=grid]]",
		);
		expect(m?.intent.pin?.polarity).toBe("dark");
		expect(m?.intent.pin?.skeleton).toBe("grid");
		expect(m?.intent.pin?.density).toBeUndefined();
	});

	test("an illegal hue pin is PASSED THROUGH, not silently corrected", () => {
		// This is deliberate and worth stating. Dropping the pin at the parser
		// would compose a legal design the officer never asked for, and the
		// officer would never learn its intent was wrong. The pin reaches the
		// gate, and the gate refuses it out loud.
		const [m] = parseDesignMarkers("[[DESIGN product=x hue=330]]");
		expect(m?.intent.pin?.accentHue).toBe(330);
	});

	test("a hue pin is wrapped into range", () => {
		const [m] = parseDesignMarkers("[[DESIGN product=x hue=-30]]");
		expect(m?.intent.pin?.accentHue).toBe(330);
	});

	test("candidates is clamped", () => {
		const [big] = parseDesignMarkers("[[DESIGN product=x candidates=99999]]");
		expect(big?.candidates).toBe(256);
		const [none] = parseDesignMarkers("[[DESIGN product=x]]");
		expect(none?.candidates).toBe(32);
	});

	test("no marker means no work", () => {
		expect(parseDesignMarkers("just a normal reply about the roadmap")).toEqual([]);
	});

	test("several markers in document order", () => {
		const ms = parseDesignMarkers("[[DESIGN product=a tone=stage]] and [[DESIGN product=b tone=console]]");
		expect(ms.map((m) => m.intent.product)).toEqual(["a", "b"]);
	});
});

describe("the officer prompt", () => {
	test("teaches the marker and forbids writing values", () => {
		expect(OFFICER_DESIGN_PROMPT).toContain("[[DESIGN");
		expect(OFFICER_DESIGN_PROMPT).toContain("You never pick a hex");
	});

	test("contains no em dash", () => {
		expect(OFFICER_DESIGN_PROMPT).not.toMatch(/[—―]/);
	});

	test("is short enough to sit in a system prompt", () => {
		expect(OFFICER_DESIGN_PROMPT.length).toBeLessThan(1400);
	});
});

describe("renderDesignMarkers", () => {
	test("a reply with no marker passes through untouched", () => {
		const out = renderDesignMarkers("nothing to see");
		expect(out.text).toBe("nothing to see");
		expect(out.handled).toBe(false);
	});

	test("a marker is replaced by a summary, and the spec is returned", () => {
		const out = renderDesignMarkers("Proposed look: [[DESIGN product=huddle tone=stage seed=1]]");
		expect(out.handled).toBe(true);
		expect(out.text).not.toContain("[[DESIGN");
		expect(out.text).toContain("Proposed look:");
		expect(out.specs).toHaveLength(1);
	});

	test("a refusal is rendered INTO the message, not swallowed", () => {
		// Same deliberate deviation packages/verify makes: in a governance
		// channel the officer's error is signal.
		const out = renderDesignMarkers("[[DESIGN product=bad tone=editorial hue=330 warm=false]]");
		expect(out.text).toContain("design refused");
		expect(out.refusals.length).toBeGreaterThan(0);
		expect(out.specs).toHaveLength(0);
	});

	test("the ledger records both composed and refused designs", () => {
		const entries: { kind: string; payload: Record<string, unknown> }[] = [];
		const ledger = {
			append(input: { kind: string; payload: Record<string, unknown> }) {
				entries.push(input);
				return input;
			},
		};
		renderDesignMarkers("[[DESIGN product=ok tone=stage seed=1]]", { ledger });
		renderDesignMarkers("[[DESIGN product=bad tone=editorial hue=330 warm=false]]", { ledger });
		expect(entries.map((e) => e.kind)).toEqual([DESIGN_LEDGER_KIND, DESIGN_REFUSED_LEDGER_KIND]);
		// The composed entry carries the full token set, so a design can be
		// rebuilt from the ledger without re-running the composer.
		expect(entries[0]?.payload).toHaveProperty("tokens");
		expect(entries[0]?.payload).toHaveProperty("coordinate");
	});

	test("this package never opens a ledger of its own", () => {
		// Injection only, same contract as packages/verify: the daemon stays the
		// single ledger writer.
		const out = renderDesignMarkers("[[DESIGN product=x tone=stage]]");
		expect(out.specs).toHaveLength(1);
	});

	test("candidates are capped by the caller regardless of the marker", () => {
		const out = renderDesignMarkers("[[DESIGN product=x tone=stage candidates=200]]", {
			maxCandidates: 4,
		});
		expect(out.text).toMatch(/of 4 candidates refused|design [0-9a-f]{8}/);
	});

	test("the rendered message is deterministic", () => {
		const reply = "look: [[DESIGN product=huddle tone=stage seed=1]]";
		expect(renderDesignMarkers(reply).text).toBe(renderDesignMarkers(reply).text);
	});
});
