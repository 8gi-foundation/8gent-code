import { describe, expect, test } from "bun:test";
import { bubbleWidths, chatColumnWidth, contextRailHasNews } from "./chat-layout";

describe("chatColumnWidth", () => {
	test("160 columns, context and activity rails, no plan: the 92 the pilot frame measured", () => {
		// Frame 00107 of pilot run l3-bugfix-m5: the chat column spans cols 31..122.
		expect(chatColumnWidth(160, { context: true, activity: true })).toBe(92);
	});

	test("an open PLAN column takes its width and one gap", () => {
		expect(chatColumnWidth(160, { context: true, planWidth: 24, activity: true })).toBe(67);
	});

	test("80 columns, no rails: the whole frame less its border and padding", () => {
		expect(chatColumnWidth(80, { context: false, activity: false })).toBe(76);
	});

	test("never goes below the floor", () => {
		expect(chatColumnWidth(40, { context: true, planWidth: 24, activity: true })).toBe(24);
	});
});

describe("bubbleWidths", () => {
	test("the assistant reply takes the full column (audit #5: it wrapped at 62 in a 92 column box)", () => {
		expect(bubbleWidths(92, "assistant")).toEqual({ bubble: 90, wrap: 88 });
	});

	test("a user message keeps the 78% bubble", () => {
		expect(bubbleWidths(92, "user")).toEqual({ bubble: 70, wrap: 68 });
	});

	test("narrow columns keep the minimum bubble", () => {
		expect(bubbleWidths(10, "assistant")).toEqual({ bubble: 16, wrap: 14 });
		expect(bubbleWidths(10, "user")).toEqual({ bubble: 16, wrap: 14 });
	});
});

describe("contextRailHasNews (audit 2026-09-30, #5)", () => {
	test("defaults (approval ask, ADHD off): the rail steps aside", () => {
		expect(contextRailHasNews({ infinite: false, adhdMode: false })).toBe(false);
	});

	test("infinite approval brings the rail back", () => {
		expect(contextRailHasNews({ infinite: true, adhdMode: false })).toBe(true);
	});

	test("ADHD mode brings the rail back", () => {
		expect(contextRailHasNews({ infinite: false, adhdMode: true })).toBe(true);
	});

	test("at 160 with the PLAN column open, the chat gets the rail's 29 columns back", () => {
		const withRail = chatColumnWidth(160, { context: true, planWidth: 24, activity: true });
		const without = chatColumnWidth(160, { context: false, planWidth: 24, activity: true });
		expect(without - withRail).toBe(29);
		expect(without).toBe(96);
	});
});
