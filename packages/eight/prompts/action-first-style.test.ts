/**
 * Opt-in "action-first" communication style (#3487).
 *
 * - The style text reaches the prompt only when the user picked it.
 * - Every existing style, and no style at all, produces exactly the same
 *   Communication style line as before the change.
 * - Onboarding accepts the new choice by number and by name, and an unknown
 *   answer still falls back to the old default.
 */

import { describe, expect, test } from "bun:test";
import { ONBOARDING_QUESTIONS, type UserConfig } from "../../self-autonomy/onboarding";
import { ACTION_FIRST_PRECEDENCE, ACTION_FIRST_STYLE, USER_CONTEXT_SEGMENT } from "./system-prompt";

function styleLine(style: string | null): string | undefined {
	const out = USER_CONTEXT_SEGMENT({ name: "Test", communicationStyle: style });
	return out.split("\n").find((l) => l.startsWith("Communication style:"));
}

// The exact lines main produced before #3487. Do not edit to make a test pass.
const BEFORE: Record<string, string> = {
	concise: "Communication style: **concise**. Be brief and direct. Skip explanations unless asked.",
	detailed: "Communication style: **detailed**. Explain your reasoning. Teach as you go.",
	casual: "Communication style: **casual**. Keep it friendly and collaborative. We're partners.",
	formal: "Communication style: **formal**. Maintain professional tone. Be precise.",
	sarcastic: "Communication style: **sarcastic**. ",
};

describe("action-first style text", () => {
	test("present when selected", () => {
		const out = USER_CONTEXT_SEGMENT({ name: "Test", communicationStyle: "action-first" });
		expect(out).toContain("Communication style: **action-first**.");
		expect(out).toContain(ACTION_FIRST_STYLE);
	});

	test("absent for every other style and for no style", () => {
		for (const style of [...Object.keys(BEFORE), null, "unknown-style"]) {
			const out = USER_CONTEXT_SEGMENT({ name: "Test", communicationStyle: style });
			expect(out).not.toContain(ACTION_FIRST_STYLE);
			expect(out).not.toContain('"Next:"');
		}
	});

	test("existing styles are byte-identical to before", () => {
		for (const [style, line] of Object.entries(BEFORE)) {
			expect(styleLine(style)).toBe(line);
		}
		expect(styleLine(null)).toBeUndefined();
	});

	test("precedence line is present only when action-first is selected", () => {
		// The base prompt asks for a joke COMPLETED line (packages/eight/prompt.ts) and
		// the personality block adds greeting and completion phrases (agent.ts).
		// action-first must say it wins over both.
		expect(ACTION_FIRST_STYLE).toContain(ACTION_FIRST_PRECEDENCE);
		expect(ACTION_FIRST_PRECEDENCE).toMatch(/override/);
		for (const word of ["greetings", "completion phrases", "jokes", "summaries"]) {
			expect(ACTION_FIRST_PRECEDENCE).toContain(word);
		}
		expect(ACTION_FIRST_PRECEDENCE).toContain('just before the single "Next:" line');
		const on = USER_CONTEXT_SEGMENT({ name: "Test", communicationStyle: "action-first" });
		expect(on).toContain(ACTION_FIRST_PRECEDENCE);
		for (const style of [...Object.keys(BEFORE), null, "unknown-style"]) {
			const out = USER_CONTEXT_SEGMENT({ name: "Test", communicationStyle: style });
			expect(out).not.toContain(ACTION_FIRST_PRECEDENCE);
			expect(out).not.toContain("override any other instruction");
		}
	});

	test("rules are short and dash-free", () => {
		const lines = ACTION_FIRST_STYLE.split("\n");
		expect(lines.length).toBeLessThanOrEqual(9);
		expect(ACTION_FIRST_STYLE).not.toMatch(/[\u2013\u2014]/);
		expect(lines[lines.length - 1]).toContain('"Next:"');
	});
});

describe("onboarding accepts action-first", () => {
	const q = ONBOARDING_QUESTIONS.find((x) => x.step === "communication");
	if (!q) throw new Error("communication question missing");

	function pick(answer: string): string | null {
		const user = {
			identity: { communicationStyle: null },
			completedSteps: [],
		} as unknown as UserConfig;
		return q!.processor(answer, user).identity.communicationStyle;
	}

	test("by number and by name", () => {
		expect(pick("6")).toBe("action-first");
		expect(pick("action-first")).toBe("action-first");
		expect(pick("ACTION-FIRST")).toBe("action-first");
		expect(q.options).toContain("6");
		expect(q.options).toContain("action-first");
		expect(q.choices?.map((c) => c.value)).toEqual(["1", "2", "3", "4", "5", "6"]);
	});

	test("existing choices map as before; unknown still falls back to the old default", () => {
		expect(pick("1")).toBe("sarcastic");
		expect(pick("2")).toBe("concise");
		expect(pick("3")).toBe("detailed");
		expect(pick("4")).toBe("casual");
		expect(pick("5")).toBe("formal");
		expect(pick("7")).toBe("sarcastic");
		expect(pick("adhd")).toBe("sarcastic");
	});
});
