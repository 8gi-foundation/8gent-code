import { describe, expect, test } from "bun:test";
import { bubbleWidths, chatColumnWidth } from "./chat-layout";

describe("chatColumnWidth", () => {
	test("160 columns, activity rail, no plan: the chat gets the old context rail's 29 columns (#3238)", () => {
		// With the context rail it was 92 (pilot frame 00107, l3-bugfix-m5).
		expect(chatColumnWidth(160, { activity: true })).toBe(121);
	});

	test("an open PLAN column takes its width and one gap", () => {
		expect(chatColumnWidth(160, { planWidth: 24, activity: true })).toBe(96);
	});

	test("80 columns, no rails: the whole frame less its border and padding", () => {
		expect(chatColumnWidth(80, { activity: false })).toBe(76);
	});

	test("never goes below the floor", () => {
		expect(chatColumnWidth(40, { planWidth: 24, activity: true })).toBe(24);
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
