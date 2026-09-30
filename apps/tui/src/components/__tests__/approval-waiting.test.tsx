/**
 * While an approval card is pending, the HUD says the turn waits on the
 * person (#3118). Before, the card was the only surface telling the truth:
 * the pill said "thinking", the NOW strip spun on the gated tool, the line
 * under the card said "Running run_command ..." and the input offered to
 * queue a follow-up.
 */
import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import React from "react";

import { deriveLilEightState, nextLilEightChangeAt } from "../../hooks/useLilEightState.js";
import { CommandInput, WAITING_LINE, WAITING_PLACEHOLDER } from "../command-input.js";
import { LilEightBadge } from "../LilEightBadge.js";
import { LiveFocalStrip, WAITING_STEP } from "../LiveFocalStrip.js";

const busy = {
	messages: [{ id: "t1", role: "tool" as const, content: "run_command" }],
	isProcessing: true,
	lastTurnEndedAt: null,
	lastTurnSuccess: null,
	now: 1_000_000,
	idleSinceMs: 0,
};

describe("header pill", () => {
	test("says waiting while a card is pending, even mid-turn", () => {
		expect(deriveLilEightState({ ...busy, approvalPending: true })).toBe("waiting");
	});

	test("goes back to the running state once the card settles", () => {
		expect(deriveLilEightState({ ...busy, approvalPending: false })).toBe("thinking");
		expect(deriveLilEightState(busy)).toBe("thinking");
	});

	test("schedules no timed change while waiting: only the person moves it", () => {
		const idle = { ...busy, isProcessing: false, approvalPending: true };
		expect(nextLilEightChangeAt(idle)).toBeNull();
	});

	test("the badge renders the word", () => {
		const out = renderToString(<LilEightBadge state="waiting" />, { columns: 40 });
		expect(out).toContain("waiting");
	});
});

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
