import { describe, expect, test } from "bun:test";
import {
	describeThinking,
	effectiveThinking,
	nextThinkingChoice,
	parseThinkingChoice,
	sessionThinkingLevel,
	visibleMessages,
} from "./thinking.js";

describe("/thinking (#3918 D4)", () => {
	test("parses the levels by name, case-insensitive, nothing else", () => {
		expect(parseThinkingChoice("HIGH")).toBe("high");
		expect(parseThinkingChoice(" off ")).toBe("off");
		expect(parseThinkingChoice("minimal")).toBe("minimal");
		expect(parseThinkingChoice("Auto")).toBe("auto");
		expect(parseThinkingChoice("MAX")).toBe("max");
		expect(parseThinkingChoice("turbo")).toBeNull();
		expect(parseThinkingChoice(undefined)).toBeNull();
	});

	test("the cycle key goes auto, off, low, medium, high, max, auto", () => {
		expect(nextThinkingChoice("auto")).toBe("off");
		expect(nextThinkingChoice("off")).toBe("low");
		expect(nextThinkingChoice("low")).toBe("medium");
		expect(nextThinkingChoice("medium")).toBe("high");
		expect(nextThinkingChoice("high")).toBe("max");
		expect(nextThinkingChoice("max")).toBe("auto");
		expect(nextThinkingChoice("minimal")).toBe("low");
	});

	test("the request is clamped to what the provider supports", () => {
		expect(effectiveThinking("off", ["low", "high"])).toBeNull();
		expect(effectiveThinking("auto", ["low", "high"])).toBeNull();
		expect(effectiveThinking("max", ["low", "medium", "high"])).toBe("high");
		expect(effectiveThinking("max", ["low"])).toBe("low");
		expect(effectiveThinking("high", ["minimal", "low"])).toBe("low");
		expect(effectiveThinking("high", [])).toBeNull();
		expect(effectiveThinking("medium", ["minimal", "low", "medium", "high"])).toBe("medium");
	});

	test("the chat line says what the provider will do, and never that nothing is sent", () => {
		expect(describeThinking("off", "ollama", [])).toContain("Thinking: off.");
		expect(describeThinking("auto", "ollama", [])).toContain("Thinking: auto.");
		expect(describeThinking("high", "ollama", [])).toContain("supports no thinking levels");
		expect(describeThinking("high", "anthropic", ["low"])).toContain("clamped to low");
		expect(describeThinking("low", "anthropic", ["low", "high"])).toBe("Thinking: low.");
		expect(describeThinking("max", "anthropic", ["low", "high"])).toBe(
			"Thinking: max. Sent as high: no provider has a level above it.",
		);
		for (const level of ["auto", "off", "low", "high", "max"] as const) {
			expect(describeThinking(level, "anthropic", ["low"])).not.toContain("not yet sent");
		}
	});

	test("the session takes auto, off and the levels; minimal is low", () => {
		expect(sessionThinkingLevel("auto")).toBe("auto");
		expect(sessionThinkingLevel("off")).toBe("off");
		expect(sessionThinkingLevel("minimal")).toBe("low");
		expect(sessionThinkingLevel("high")).toBe("high");
		expect(sessionThinkingLevel("max")).toBe("max");
	});

	test("hiding thinking drops the tool-choosing bubbles and nothing else (D10)", () => {
		const msgs = [
			{ id: "user-1", role: "user" },
			{ id: "system-step0-2", role: "system" },
			{ id: "assistant-3", role: "assistant" },
		];
		expect(visibleMessages(msgs, true).map((m) => m.id)).toEqual([
			"user-1",
			"system-step0-2",
			"assistant-3",
		]);
		expect(visibleMessages(msgs, false).map((m) => m.id)).toEqual(["user-1", "assistant-3"]);
	});
});
