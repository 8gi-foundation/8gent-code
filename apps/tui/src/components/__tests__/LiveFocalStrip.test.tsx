import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import type React from "react";
/**
 * LiveFocalStrip tests
 *
 * Covers the pure meter() helper for clamp behaviour and verifies that
 * the component module exports the expected surface. Rendering through
 * Ink is intentionally not exercised here - the repo uses launch smoke
 * tests for that, see apps/tui/src/__tests__/smoke.test.ts.
 */
import { t } from "../../theme.js";

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

	test("idle state uses subtle border color", () => {
		const element = LiveFocalStrip({
			mode: "Planning",
			activeStep: "Drafting strip",
			route: "auto",
			tokens: "2.4k",
			contextPct: 35,
		});
		expect(element).toBeDefined();
		// At rest the strip's edge is the frame token, like every edge (#3238).
		expect(element.props.borderColor).toBe(t.frame);
		// One border style in every state: only the colour changes.
		expect(element.props.borderStyle).toBe("single");
	});

	test("processing flips border to teal", () => {
		const element = LiveFocalStrip({
			mode: "Planning",
			activeStep: "Drafting strip",
			route: "auto",
			tokens: "2.4k",
			contextPct: 35,
			isProcessing: true,
		});
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

describe("the NOW strip shows the state, not the ^Y mode (#3123)", () => {
	const base = {
		activeStep: "thinking...",
		route: "qwen3.8:27b-mlx",
		tokens: "6.3K tok",
		contextPct: 5,
		animate: false,
		width: 92,
	};
	const draw = (props: Partial<React.ComponentProps<typeof LiveFocalStrip>>) =>
		renderToString(<LiveFocalStrip mode="Planning" {...base} {...props} />, { columns: 92 });

	test("running, done and idle never print the mode word", () => {
		const running = draw({ isProcessing: true });
		expect(running).toContain("NOW");
		expect(running).toContain("thinking...");
		const done = draw({ lastTurnEndedAt: Date.now() - 60_000, lastTurnSuccess: true });
		expect(done).toContain("DONE");
		expect(done).toContain("finished");
		expect(draw({})).toContain("READY");
		for (const out of [running, done, draw({})]) expect(out).not.toContain("Planning");
	});

	test("Infinite is named once, in the header and footer, not beside the state (#3238)", () => {
		const out = draw({ isProcessing: true, autonomous: true });
		expect(out).toContain("NOW");
		expect(out).not.toContain("Autonomous");
		expect(out).not.toContain("Planning");
	});

	test("at rest the strip says READY once, with no idle word beside it (#3238)", () => {
		const out = draw({});
		expect(out).toContain("READY");
		expect(out).not.toContain("idle");
	});
});

describe("no ready model: the strip never says READY or names a model (#3290)", () => {
	const base = {
		activeStep: "idle",
		route: "ornith-1.0-9b",
		tokens: "",
		contextPct: 0,
		animate: false,
	};
	const reason = "Ollama at http://127.0.0.1:11434 did not answer.";
	const draw = (props: Partial<React.ComponentProps<typeof LiveFocalStrip>>, columns = 120) =>
		renderToString(<LiveFocalStrip mode="Planning" {...base} width={columns} {...props} />, { columns });

	test("nothing can answer: NO MODEL with the reason, no READY, no model name", () => {
		for (const columns of [120, 80]) {
			const out = draw({ notReady: { kind: "none", reason } }, columns);
			expect(out).toContain("NO MODEL");
			expect(out).toContain("Ollama at");
			expect(out).not.toContain("READY");
			expect(out).not.toContain("ornith");
		}
	});

	test("the reason shows with no width given too", () => {
		const out = renderToString(
			<LiveFocalStrip mode="Planning" {...base} notReady={{ kind: "none", reason }} />,
			{ columns: 120 },
		);
		expect(out).toContain("NO MODEL");
		expect(out).not.toContain("ornith");
	});

	test("before the first probe: CHECK, looking for a model, no READY", () => {
		const out = draw({ notReady: { kind: "checking", reason: "looking for a model" } });
		expect(out).toContain("CHECK");
		expect(out).toContain("looking for a model");
		expect(out).not.toContain("READY");
		expect(out).not.toContain("ornith");
	});

	test("a finished turn whose model then went away is not DONE either", () => {
		const out = draw({
			notReady: { kind: "none", reason },
			lastTurnEndedAt: Date.now() - 60_000,
			lastTurnSuccess: true,
		});
		expect(out).toContain("NO MODEL");
		expect(out).not.toContain("DONE");
		expect(out).not.toContain("finished");
	});

	test("a ready agent still reads READY and names its model", () => {
		const out = draw({ notReady: null });
		expect(out).toContain("READY");
		expect(out).toContain("ornith-1.0-9b");
	});

	test("NO MODEL keeps the frame border: no card waits on the person", () => {
		const el = LiveFocalStrip({ mode: "Planning", ...base, notReady: { kind: "none", reason } });
		expect(el.props.borderColor).toBe(t.frame);
	});
});
