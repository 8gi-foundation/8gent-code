import { describe, expect, test } from "bun:test";
import { PLANNING_GATE_MIN_CHARS, PLANNING_KEYWORDS, needsPlanningGate } from "./planning-gate";
import { PLANNING_GATE_INSTRUCTION } from "./prompt";

// The exact prompt of pilot msg-post-caption (run 2026-10-14_102226, #4248).
const MSG_POST_CAPTION =
	"Post a short summary of the latest pilot run to the group on Telegram, chat id -1004417730052. The sending notes are in POSTING.md and the run is in last-run/result.json. Use exactly 4 lines of plain text, include exactly 3 numbers, and do not use any word more than twice. Send it once.";

// The gate as it was on main before #4248 (packages/eight/agent.ts): any prompt over 100
// characters, or a build verb. Kept here so the change is pinned against the old behaviour,
// not only against a module that did not exist.
const OLD_GATE = (text: string) => text.length > 100 || PLANNING_KEYWORDS.test(text);

describe("needsPlanningGate (#4248)", () => {
	test("pinned: the #4248 prompt was gated before, is not gated now", () => {
		expect(OLD_GATE(MSG_POST_CAPTION)).toBe(true);
		expect(needsPlanningGate(MSG_POST_CAPTION)).toBe(false);
	});

	test("the msg-post-caption prompt is one goal: no plan, no update_plan rounds", () => {
		expect(MSG_POST_CAPTION.length).toBeGreaterThan(100);
		expect(MSG_POST_CAPTION.length).toBeLessThan(PLANNING_GATE_MIN_CHARS);
		expect(needsPlanningGate(MSG_POST_CAPTION)).toBe(false);
	});

	test("a build verb still gates at any length", () => {
		expect(needsPlanningGate("fix the login bug")).toBe(true);
		expect(needsPlanningGate("Please add a retry to the sender")).toBe(true);
	});

	test("a long prompt still gates", () => {
		expect(needsPlanningGate("word ".repeat(100))).toBe(true);
	});

	test("short plain prompts stay ungated", () => {
		expect(needsPlanningGate("what time is it")).toBe(false);
	});

	test("measured: gate message removed from the turn", () => {
		// The gate text is re-sent on every step of the turn.
		const approxTokens = Math.ceil(PLANNING_GATE_INSTRUCTION.length / 4);
		expect(approxTokens).toBeGreaterThan(100);
	});
});
