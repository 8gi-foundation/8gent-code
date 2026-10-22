import { describe, expect, test } from "bun:test";
import { autoSwitchLine } from "../../../../packages/providers/only-runnable";
import { createFallbackNoticeGate } from "./fallback-notice-once";

/** What a session prints across turns when each turn reports the same fallback. */
function transcript(turns: { from: string; to: string; model: string }[]): string[] {
	const gate = createFallbackNoticeGate();
	const lines: string[] = [];
	for (const t of turns) {
		if (gate(t.from, `${t.to}/${t.model}`)) lines.push(autoSwitchLine(t.from, "MiniMax", t.model));
	}
	return lines;
}

describe("fallback notice once per session (#4754)", () => {
	test("two turns with the same fallback print one line; a changed target prints a second", () => {
		const same = { from: "ollama", to: "minimax", model: "MiniMax-M3.1-Flash" };
		expect(transcript([same, same])).toEqual([
			"Ollama is not running; using MiniMax MiniMax-M3.1-Flash. /provider to change.",
		]);
		expect(transcript([same, same, { ...same, model: "MiniMax-M3.1" }])).toEqual([
			"Ollama is not running; using MiniMax MiniMax-M3.1-Flash. /provider to change.",
			"Ollama is not running; using MiniMax MiniMax-M3.1. /provider to change.",
		]);
	});

	test("alternating engines each say it once, not once per turn", () => {
		const ollama = { from: "ollama", to: "minimax", model: "m" };
		const lms = { from: "lmstudio", to: "minimax", model: "m" };
		expect(transcript([ollama, lms, ollama, lms, ollama, lms])).toHaveLength(2);
	});
});
