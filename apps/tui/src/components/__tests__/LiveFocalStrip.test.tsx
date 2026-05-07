/**
 * LiveFocalStrip tests
 *
 * Covers the pure meter() helper for clamp behaviour and verifies that
 * the component module exports the expected surface. Rendering through
 * Ink is intentionally not exercised here - the repo uses launch smoke
 * tests for that, see apps/tui/src/__tests__/smoke.test.ts.
 */
import { describe, expect, test } from "bun:test";

import { LiveFocalStrip, meter } from "../LiveFocalStrip.js";

describe("meter", () => {
	test("0 percent renders all empty cells", () => {
		expect(meter(0)).toBe("░░░░░░░░░░");
	});

	test("50 percent renders half-filled bar", () => {
		expect(meter(50)).toBe("█████░░░░░");
	});

	test("100 percent renders all filled cells", () => {
		expect(meter(100)).toBe("██████████");
	});

	test("over-cap clamps to width (no overflow)", () => {
		expect(meter(150)).toBe("██████████");
	});

	test("under-cap clamps to zero (no underflow)", () => {
		expect(meter(-10)).toBe("░░░░░░░░░░");
	});

	test("custom width respected", () => {
		expect(meter(50, 4)).toBe("██░░");
		expect(meter(150, 4)).toBe("████");
		expect(meter(-1, 4)).toBe("░░░░");
	});
});

describe("LiveFocalStrip exports", () => {
	test("component is defined", () => {
		expect(LiveFocalStrip).toBeDefined();
		expect(typeof LiveFocalStrip).toBe("function");
	});

	test("default state (no approvalPending) is callable", () => {
		const element = LiveFocalStrip({
			mode: "Planning",
			activeStep: "Drafting strip",
			route: "auto",
			tokens: "2.4k",
			contextPct: 35,
		});
		expect(element).toBeDefined();
		expect(element.props.borderColor).toBe("#7DA8A3");
	});

	test("approvalPending flips border to orange", () => {
		const element = LiveFocalStrip({
			mode: "Implementing",
			activeStep: "Awaiting approval",
			route: "auto",
			tokens: "2.4k",
			contextPct: 60,
			approvalPending: true,
		});
		expect(element.props.borderColor).toBe("#E8610A");
	});
});
