// Migration snapshot tests for the success-prompt render in packages/infinite.
//
// Before: defaultSuccessCriteria built the prompt with a chain of
// String.replace calls (first-occurrence-only, no missing-var detection).
// After: render() from packages/tools/prompt-template.
// These tests prove the new path produces IDENTICAL output for the shipped
// prompt, and that the old path's bug classes are now covered.

import { describe, expect, test } from "bun:test";
import { render } from "../tools/prompt-template";
import { DEFAULT_SUCCESS_PROMPT, InfiniteRunner, type InfiniteState, successPromptVars } from "./index";

// The pre-migration implementation, copied verbatim from
// packages/infinite/index.ts defaultSuccessCriteria (before this change).
function legacyRender(successPrompt: string, state: InfiniteState): string {
	return successPrompt
		.replace("{{TASK}}", state.task)
		.replace("{{ITERATIONS}}", state.iteration.toString())
		.replace("{{FILES}}", state.filesChanged.join(", ") || "none")
		.replace("{{COMMANDS}}", state.commandsExecuted.slice(-10).join(", ") || "none")
		.replace("{{LAST_RESPONSE}}", state.lastResponse?.slice(0, 500) || "none")
		.replace("{{ERRORS}}", state.recoveredErrors.length.toString());
}

function makeState(overrides: Partial<InfiniteState> = {}): InfiniteState {
	return {
		iteration: 7,
		elapsedMs: 1234,
		startTime: new Date(0),
		recoveredErrors: [new Error("boom"), new Error("bang")],
		filesChanged: ["a.ts", "b.ts"],
		commandsExecuted: ["bun test", "git status"],
		phase: "progress",
		progressEstimate: 50,
		task: "ship the template engine",
		results: [],
		lastResponse: "All tests pass.",
		...overrides,
	} as InfiniteState;
}

describe("infinite success prompt migration", () => {
	test("render matches the legacy replace chain for the shipped DEFAULT_SUCCESS_PROMPT", () => {
		const state = makeState();
		expect(render(DEFAULT_SUCCESS_PROMPT, successPromptVars(state))).toBe(
			legacyRender(DEFAULT_SUCCESS_PROMPT, state),
		);
	});

	test("parity holds for the empty-state fallbacks", () => {
		const state = makeState({
			filesChanged: [],
			commandsExecuted: [],
			recoveredErrors: [],
			lastResponse: undefined,
			iteration: 0,
		});
		expect(render(DEFAULT_SUCCESS_PROMPT, successPromptVars(state))).toBe(
			legacyRender(DEFAULT_SUCCESS_PROMPT, state),
		);
	});

	test("no literal {{ tags survive rendering", () => {
		const out = render(DEFAULT_SUCCESS_PROMPT, successPromptVars(makeState()));
		expect(out.includes("{{")).toBe(false);
	});

	test("a custom prompt reusing {{TASK}} now renders every occurrence (legacy rendered only the first)", () => {
		const prompt = "Task: {{TASK}}. Confirm that {{TASK}} is complete.";
		const state = makeState({ task: "X" });
		const legacy = legacyRender(prompt, state);
		const now = render(prompt, successPromptVars(state));
		expect(legacy).toBe("Task: X. Confirm that {{TASK}} is complete."); // the old bug
		expect(now).toBe("Task: X. Confirm that X is complete."); // fixed
	});

	test("a typo'd custom successPrompt is rejected at construction, not silently swallowed", () => {
		expect(
			() => new InfiniteRunner("t", { successPrompt: "Check {{TASKK}} please" }),
		).toThrow("unknown variable(s): TASKK");
	});

	test("a structurally broken custom successPrompt is rejected at construction", () => {
		expect(() => new InfiniteRunner("t", { successPrompt: "{{#if TASK}}no close" })).toThrow(
			"invalid successPrompt",
		);
	});

	test("the shipped default prompt passes construction", () => {
		expect(() => new InfiniteRunner("t")).not.toThrow();
	});
});
