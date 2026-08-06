/**
 * Pure-logic unit tests for the huddle floor protocol's helper functions
 * (docs/8GENT-HUDDLE-SPEC.md section 12). The full state-machine / wire-level
 * success criteria (SC-1 through SC-4) live in
 * packages/daemon/__tests__/huddle-floor.test.ts, which needs a TableStore and
 * a stub AgentPool; these do not - they exercise floor.ts's pure functions
 * directly, fast, with zero IO.
 */

import { describe, expect, it } from "bun:test";
import {
	CHAIR_PROMPT_TOKEN_BUDGET,
	READING_MS_CEILING,
	READING_MS_FLOOR,
	assertPromptBudget,
	buildChairDigest,
	deriveRing,
	estimateReadingMs,
	estimateTokens,
	firstSentence,
} from "../floor";

describe("deriveRing", () => {
	it("removes the chair and preserves roster order", () => {
		expect(deriveRing(["human:james", "agent:8TO", "agent:8SO"], "human:james")).toEqual([
			"agent:8TO",
			"agent:8SO",
		]);
	});

	it("dedupes while preserving first-seen order", () => {
		expect(deriveRing(["agent:8TO", "agent:8SO", "agent:8TO"], "human:james")).toEqual([
			"agent:8TO",
			"agent:8SO",
		]);
	});

	it("is a pure function - identical inputs, identical output, every time", () => {
		const roster = ["human:james", "agent:8TO", "agent:8SO", "agent:8GO", "agent:8DO"];
		const first = deriveRing(roster, "human:james");
		for (let i = 0; i < 200; i++) {
			expect(deriveRing(roster, "human:james")).toEqual(first);
		}
	});

	it("chair absent from roster still yields the full roster as ring", () => {
		expect(deriveRing(["agent:8TO", "agent:8SO"], "human:james")).toEqual(["agent:8TO", "agent:8SO"]);
	});
});

describe("estimateReadingMs", () => {
	it("floors at READING_MS_FLOOR for short/empty text", () => {
		expect(estimateReadingMs("")).toBe(READING_MS_FLOOR);
		expect(estimateReadingMs("hi")).toBe(READING_MS_FLOOR);
	});

	it("caps at READING_MS_CEILING for very long text", () => {
		const long = new Array(500).fill("word").join(" ");
		expect(estimateReadingMs(long)).toBe(READING_MS_CEILING);
	});

	it("scales with word count between the floor and ceiling", () => {
		// 40 words / 2.6 wps = ~15385ms, comfortably between floor and ceiling.
		const words = new Array(40).fill("word").join(" ");
		const ms = estimateReadingMs(words);
		expect(ms).toBeGreaterThan(READING_MS_FLOOR);
		expect(ms).toBeLessThan(READING_MS_CEILING);
	});

	it("is deterministic - same text, same estimate, every time", () => {
		const text = "a moderately sized spoken turn with a handful of words in it";
		const first = estimateReadingMs(text);
		for (let i = 0; i < 50; i++) expect(estimateReadingMs(text)).toBe(first);
	});
});

describe("firstSentence", () => {
	it("takes only the first sentence", () => {
		expect(firstSentence("First point. Second point. Third point.")).toBe("First point.");
	});

	it("hard-caps at the given length with an ellipsis", () => {
		const long = `This is a very long single sentence that goes on and on ${"and on ".repeat(40)}without stopping.`;
		const capped = firstSentence(long, 50);
		expect(capped.length).toBeLessThanOrEqual(50);
		expect(capped.endsWith("…")).toBe(true);
	});

	it("falls back to the whole trimmed text when there is no terminator", () => {
		expect(firstSentence("no terminator here")).toBe("no terminator here");
	});
});

describe("buildChairDigest", () => {
	it("emits one line per turn: 'Name (CODE): first sentence'", () => {
		const digest = buildChairDigest([
			{ code: "8TO", name: "Rishi", text: "Ship the small fix. It is low risk." },
			{ code: "8SO", name: "Karen", text: "Agreed, no new attack surface." },
		]);
		expect(digest).toBe("Rishi (8TO): Ship the small fix.\nKaren (8SO): Agreed, no new attack surface.");
	});

	it("is a pure, deterministic function of its entries", () => {
		const entries = [{ code: "8TO", name: "Rishi", text: "Point one. Point two." }];
		const first = buildChairDigest(entries);
		for (let i = 0; i < 50; i++) expect(buildChairDigest(entries)).toBe(first);
	});
});

describe("assertPromptBudget - loud failure over silent truncation (spec 10.5)", () => {
	it("does not throw for a prompt comfortably under budget", () => {
		expect(() => assertPromptBudget("short chair prompt")).not.toThrow();
	});

	it("throws when the estimated token count exceeds the budget", () => {
		const huge = "x".repeat((CHAIR_PROMPT_TOKEN_BUDGET + 500) * 4);
		expect(estimateTokens(huge)).toBeGreaterThan(CHAIR_PROMPT_TOKEN_BUDGET);
		expect(() => assertPromptBudget(huge)).toThrow(/exceeds budget/);
	});

	it("respects a custom max", () => {
		expect(() => assertPromptBudget("x".repeat(40), 5)).toThrow();
		expect(() => assertPromptBudget("x".repeat(40), 100)).not.toThrow();
	});
});
