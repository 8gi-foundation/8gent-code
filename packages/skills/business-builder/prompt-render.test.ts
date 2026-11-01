// Migration snapshot tests for the business-builder prompt render.
//
// Before (orchestrator.ts runAgent):
//   def.promptTemplate.replace("{{idea}}", idea).replace("{{blueprint}}", blueprint)
// After: render(def.promptTemplate, { idea, blueprint }, { onMissing: "throw" }).
// Parity is proven across ALL 10 agent templates, and the templates
// themselves are linted so a typo'd tag can never ship silently.

import { describe, expect, test } from "bun:test";
import { lint, render, validate } from "../../tools/prompt-template";
import { AGENT_DEFS } from "./agents";

// The pre-migration implementation, copied verbatim from orchestrator.ts.
function legacyRender(template: string, idea: string, blueprint: string): string {
	return template.replace("{{idea}}", idea).replace("{{blueprint}}", blueprint);
}

const IDEA = "A subscription service for locally roasted coffee";
const BLUEPRINT = "Phase 1 blueprint:\n- DTC subscriptions\n- Tiered pricing\n- B2B office plans";

describe("business-builder prompt migration", () => {
	for (const def of AGENT_DEFS) {
		test(`agent "${def.id}": render matches the legacy replace chain`, () => {
			expect(render(def.promptTemplate, { idea: IDEA, blueprint: BLUEPRINT })).toBe(
				legacyRender(def.promptTemplate, IDEA, BLUEPRINT),
			);
		});
	}

	test("every agent template lints clean", () => {
		for (const def of AGENT_DEFS) {
			expect({ id: def.id, issues: lint(def.promptTemplate) }).toEqual({
				id: def.id,
				issues: [],
			});
		}
	});

	test("every agent template only references {{idea}} and {{blueprint}}", () => {
		for (const def of AGENT_DEFS) {
			expect({ id: def.id, missing: validate(def.promptTemplate, { idea: "", blueprint: "" }) }).toEqual({
				id: def.id,
				missing: [],
			});
		}
	});

	test("no literal tags survive rendering any agent prompt", () => {
		for (const def of AGENT_DEFS) {
			const out = render(def.promptTemplate, { idea: IDEA, blueprint: BLUEPRINT });
			expect(out.includes("{{")).toBe(false);
		}
	});

	test("an idea containing $-replacement patterns is inserted verbatim (legacy String.replace hazard)", () => {
		const trickyIdea = "Sell gift cards worth $50 (promo code: $&SAVE)";
		const def = AGENT_DEFS[0];
		const out = render(def.promptTemplate, { idea: trickyIdea, blueprint: BLUEPRINT });
		expect(out).toContain(trickyIdea);
	});
});
