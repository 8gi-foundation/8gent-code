/**
 * While an approval card is pending, the HUD says the turn waits on the
 * person (#3118). Before, the card was the only surface telling the truth:
 * the header badge said "thinking" (the badge left the header in #3238), the NOW strip spun on the gated tool, the line
 * under the card said "Running run_command ..." and the input offered to
 * queue a follow-up.
 */
import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import React from "react";

import { CommandInput, WAITING_LINE, WAITING_PLACEHOLDER } from "../command-input.js";
import { LiveFocalStrip, WAITING_STEP } from "../LiveFocalStrip.js";

const strip = {
	mode: "Planning" as const,
	activeStep: "run_command",
	route: "qwen3.8:27b-mlx",
	tokens: "5.8K tok",
	contextPct: 5,
	isProcessing: true,
	animate: false,
};

describe("NOW strip", () => {
	for (const width of [92, 76]) {
		test(`holds still and says it is waiting, at ${width} columns`, () => {
			const out = renderToString(<LiveFocalStrip {...strip} approvalPending width={width} />, {
				columns: width,
			});
			expect(out).toContain("WAIT");
			expect(out).toContain(WAITING_STEP);
			expect(out).not.toContain("NOW");
			expect(out).not.toContain("run_command");
		});
	}

	test("names the running tool again once the card settles", () => {
		const out = renderToString(<LiveFocalStrip {...strip} width={92} />, { columns: 92 });
		expect(out).toContain("NOW");
		expect(out).toContain("run_command");
		expect(out).not.toContain("WAIT");
	});

	test("autonomous mode raises no card, so it never shows WAIT", () => {
		const out = renderToString(<LiveFocalStrip {...strip} approvalPending autonomous width={92} />, {
			columns: 92,
		});
		expect(out).not.toContain("WAIT");
	});
});

describe("status line and input under the card", () => {
	const input = {
		onSubmit: () => {},
		isProcessing: true,
		activeTool: "run_command",
		stepCount: 1,
		totalTokens: 5800,
		showAnimations: false,
	};

	test("say the turn waits on the person, with no spinner and no queue offer", () => {
		const out = renderToString(<CommandInput {...input} approvalPending />, { columns: 80 });
		expect(out).toContain(WAITING_LINE);
		expect(out).toContain(WAITING_PLACEHOLDER);
		expect(out).not.toContain("Running run_command");
		expect(out).not.toContain("Queue a follow-up");
	});

	test("return to the running line when the card settles", () => {
		const out = renderToString(<CommandInput {...input} />, { columns: 80 });
		expect(out).toContain("Running run_command");
		expect(out).not.toContain(WAITING_LINE);
	});
});
