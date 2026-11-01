// Migration snapshot tests for INFINITE_OFFER_PROMPT in
// packages/workflow/proactive-infinite.ts.
//
// Before: the template was exported raw with {{REFINED_TASK}} and
// {{CONFIDENCE}} and NO renderer existed anywhere in the repo - any consumer
// either hand-rolled String.replace or shipped the literal tags to the user.
// After: renderInfiniteOffer() fills every occurrence and throws on drift.

import { describe, expect, test } from "bun:test";
import { render } from "../tools/prompt-template";
import { INFINITE_OFFER_PROMPT, renderInfiniteOffer } from "./proactive-infinite";

// What a consumer of the raw export would have written pre-migration.
function legacyRender(refinedTask: string, confidence: number): string {
	return INFINITE_OFFER_PROMPT.replace("{{REFINED_TASK}}", refinedTask).replace(
		"{{CONFIDENCE}}",
		confidence.toString(),
	);
}

describe("INFINITE_OFFER_PROMPT migration", () => {
	test("renderInfiniteOffer matches the legacy replace chain for the shipped template", () => {
		expect(renderInfiniteOffer("Build the TUI theme picker", 85)).toBe(
			legacyRender("Build the TUI theme picker", 85),
		);
	});

	test("output contains the real values and no literal tags", () => {
		const out = renderInfiniteOffer("refactor the router", 92);
		expect(out).toContain("refactor the router");
		expect(out).toContain("My confidence level is 92%.");
		expect(out.includes("{{")).toBe(false);
	});

	test("template drift is detected: a renamed variable throws instead of leaking", () => {
		// Simulates someone editing the template to add/rename a var without
		// updating the renderer - the failure is loud, not a literal {{tag}}.
		const drifted = `${INFINITE_OFFER_PROMPT}\nETA: {{ETA_MINUTES}} minutes`;
		expect(() =>
			render(drifted, { REFINED_TASK: "x", CONFIDENCE: 50 }, { onMissing: "throw" }),
		).toThrow('missing variable "ETA_MINUTES"');
	});
});
