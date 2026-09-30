/**
 * Setup asked in the chat: question text, placeholder, and typed answer to
 * step value. The questions are the real ones from packages/self-autonomy.
 */

import { describe, expect, test } from "bun:test";
import { ONBOARDING_QUESTIONS } from "../../../../packages/self-autonomy/onboarding";
import { answerFromInput, placeholderFor, providerCheckLine, questionForChat } from "./onboarding-chat";

const step = (name: string) => {
	const q = ONBOARDING_QUESTIONS.find((x) => x.step === name);
	if (!q) throw new Error(`no step ${name}`);
	return q;
};

describe("the welcome", () => {
	const welcome = step("language");

	test("Enter takes its one choice, so 'Press Enter to begin' is true", () => {
		expect(answerFromInput(welcome, "")).toEqual({ value: "ok", echo: "" });
		expect(answerFromInput(welcome, "ok")).toEqual({ value: "ok", echo: "" });
	});

	test("the placeholder says the same thing", () => {
		expect(placeholderFor(welcome)).toBe("Enter to begin");
	});

	test("a one-choice step shows no numbered list", () => {
		expect(questionForChat(welcome)).toBe(welcome.question);
	});
});

describe("the name", () => {
	const identity = step("identity");

	test("the placeholder is the expected answer", () => {
		expect(placeholderFor(identity)).toBe("Your name");
	});

	test("typed text passes through; empty keeps the detected default", () => {
		expect(answerFromInput(identity, " Ada ")).toEqual({ value: "Ada", echo: "Ada" });
		expect(answerFromInput(identity, "")).toEqual({ value: "", echo: "(skipped)" });
	});
});

describe("select steps", () => {
	const role = step("role");

	test("choices are listed, numbered, labels in one column", () => {
		const text = questionForChat(role);
		const lines = text.split("\n");
		expect(lines[0]).toBe(role.question);
		expect(lines).toContain("  1  Engineer  Builder of software");
		expect(lines).toContain("  5  Other     Something else entirely");
	});

	test("a number, a label or a value picks a choice; Enter takes the first", () => {
		expect(answerFromInput(role, "2")).toEqual({ value: "designer", echo: "Designer" });
		expect(answerFromInput(role, "Founder")).toEqual({ value: "founder", echo: "Founder" });
		expect(answerFromInput(role, "hobbyist")).toEqual({ value: "hobbyist", echo: "Hobbyist" });
		expect(answerFromInput(role, "")).toEqual({ value: "engineer", echo: "Engineer" });
		expect(placeholderFor(role)).toBe("A number, or Enter for Engineer");
	});

	test("an out-of-range number is passed through for the step to judge", () => {
		expect(answerFromInput(role, "9").value).toBe("9");
	});
});

describe("agent names", () => {
	const orch = step("agent-name-orchestrator");

	test("Enter keeps the default and says so", () => {
		expect(answerFromInput(orch, "")).toEqual({ value: "", echo: "Orchestrator" });
		expect(placeholderFor(orch)).toBe("A name, or Enter to keep Orchestrator");
	});
});

describe("provider checks", () => {
	test("one line, with the install hint only when it is not running", () => {
		expect(providerCheckLine("Ollama", true, "brew install ollama")).toBe("Ollama is running.");
		expect(providerCheckLine("LM Studio", false, "Get it at lmstudio.ai")).toBe(
			"LM Studio is not running. Get it at lmstudio.ai",
		);
	});
});
