import { describe, expect, test } from "bun:test";
import {
	describeThinking,
	effectiveThinking,
	nextThinkingChoice,
	parseThinkingChoice,
	visibleMessages,
} from "./thinking.js";

describe("/thinking (#3918 D4)", () => {
	test("parses the levels by name, case-insensitive, nothing else", () => {
		expect(parseThinkingChoice("HIGH")).toBe("high");
		expect(parseThinkingChoice(" off ")).toBe("off");
		expect(parseThinkingChoice("minimal")).toBe("minimal");
		expect(parseThinkingChoice("max")).toBeNull();
		expect(parseThinkingChoice(undefined)).toBeNull();
	});

	test("the cycle key goes off, low, medium, high, off", () => {
		expect(nextThinkingChoice("off")).toBe("low");
		expect(nextThinkingChoice("low")).toBe("medium");
		expect(nextThinkingChoice("medium")).toBe("high");
		expect(nextThinkingChoice("high")).toBe("off");
		expect(nextThinkingChoice("minimal")).toBe("low");
	});

	test("the request is clamped to what the provider supports", () => {
		expect(effectiveThinking("off", ["low", "high"])).toBeNull();
		expect(effectiveThinking("high", ["minimal", "low"])).toBe("low");
		expect(effectiveThinking("high", [])).toBeNull();
		expect(effectiveThinking("medium", ["minimal", "low", "medium", "high"])).toBe("medium");
	});

	test("the chat line says what the provider will do", () => {
		expect(describeThinking("off", "ollama", [])).toBe("Thinking: off.");
		expect(describeThinking("high", "ollama", [])).toContain("supports no thinking levels");
		expect(describeThinking("high", "anthropic", ["low"])).toContain("clamped to low");
		expect(describeThinking("low", "anthropic", ["low", "high"])).toBe("Thinking: low.");
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
