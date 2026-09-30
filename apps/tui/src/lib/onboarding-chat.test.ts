/**
 * Setup asked in the chat: question text, placeholder, and typed answer to
 * step value. The questions are the real ones from packages/self-autonomy.
 */

import { describe, expect, test } from "bun:test";
import { ONBOARDING_QUESTIONS } from "../../../../packages/self-autonomy/onboarding";
import {
	SETUP_SKIP_HINT,
	SETUP_WELCOME_ID,
	SETUP_WELCOME_PROMPT,
	answerFromInput,
	placeholderFor,
	providerCheckLine,
	questionForChat,
	settleSetupTranscript,
	settledSetupCard,
} from "./onboarding-chat";

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

describe("once setup is done, nothing still asks for setup input (#3090)", () => {
	const welcome = step("language");
	const card = `Good day. I'm 8gent.\n\nFound on this machine:\nProvider ollama\n\n${SETUP_WELCOME_PROMPT}\n\n${SETUP_SKIP_HINT}`;
	const msg = (id: string, content: string, role = id.startsWith("user") ? "user" : "assistant") => ({
		id,
		content,
		role,
	});

	test("the prompt it strips is the welcome's real call to action", () => {
		expect(welcome.question.endsWith(SETUP_WELCOME_PROMPT)).toBe(true);
	});

	test("the welcome keeps its greeting and what was found, and loses the prompt and the hint", () => {
		const settled = settledSetupCard(card);
		expect(settled).toBe("Good day. I'm 8gent.\n\nFound on this machine:\nProvider ollama");
		expect(settled).not.toContain("Press Enter to begin");
		expect(settled).not.toContain("/skip");
	});

	test("/skip all at the welcome: the welcome stays, settled; other messages are untouched", () => {
		const before = [msg("sys-1", "Press Enter to begin"), msg(`${SETUP_WELCOME_ID}1`, card)];
		const after = settleSetupTranscript(before);
		expect(after.map((m) => m.id)).toEqual(["sys-1", `${SETUP_WELCOME_ID}1`]);
		expect(after[0]).toBe(before[0]);
		expect(after[1].content).not.toContain("Press Enter to begin");
	});

	test("ended by a skip later on: the unanswered question goes, answered ones stay", () => {
		const before = [
			msg(`${SETUP_WELCOME_ID}1`, card),
			msg("setup-q-2", "What should I call you?"),
			msg("user-3", "Ada"),
			msg("setup-q-4", "Ready to begin?\n\n  1  Yes, let's go\n  2  No, restart later"),
		];
		const after = settleSetupTranscript(before);
		expect(after.map((m) => m.id)).toEqual([`${SETUP_WELCOME_ID}1`, "setup-q-2", "user-3"]);
		expect(after.map((m) => m.content).join("\n")).not.toMatch(/Press Enter to begin|\/skip|Ready to begin/);
	});

	test("answered to the end: every card stays, only the prompt and hint go", () => {
		const before = [msg(`${SETUP_WELCOME_ID}1`, card), msg("setup-q-2", "Ready to begin?"), msg("user-3", "1")];
		const after = settleSetupTranscript(before);
		expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));
		expect(after[1]).toBe(before[1]);
		expect(after[0].content).not.toContain("Press Enter to begin");
	});

	test("questions skipped on the way go too, not only the last one (#3096)", () => {
		const before = [
			msg(`${SETUP_WELCOME_ID}1`, card),
			msg("setup-q-2", "What should I call you?"),
			msg("setup-q-3", "What best describes you?\n\n  1  Developer\n  2  Designer"),
			msg("setup-check-ollama-4", "Ollama is running.", "system"),
			msg("setup-q-5", "How should I communicate with you?"),
			msg("user-onboard-6", "Concise"),
			msg("setup-q-7", "Pick a voice for your agent."),
		];
		const after = settleSetupTranscript(before);
		expect(after.map((m) => m.id)).toEqual([
			`${SETUP_WELCOME_ID}1`,
			"setup-check-ollama-4",
			"setup-q-5",
			"user-onboard-6",
		]);
		const text = after.map((m) => m.content).join("\n");
		expect(text).not.toMatch(/call you|describes you|Pick a voice|Press Enter to begin|\/skip/);
	});

	test("every question skipped: only the settled welcome is left", () => {
		const before = [
			msg(`${SETUP_WELCOME_ID}1`, card),
			msg("setup-q-2", "What should I call you?"),
			msg("setup-q-3", "What best describes you?"),
			msg("setup-q-4", "Pick a voice for your agent."),
		];
		const after = settleSetupTranscript(before);
		expect(after.map((m) => m.id)).toEqual([`${SETUP_WELCOME_ID}1`]);
		expect(after[0].content).toBe("Good day. I'm 8gent.\n\nFound on this machine:\nProvider ollama");
	});

	test("a system line between a question and its answer does not unanswer it", () => {
		const before = [
			msg("setup-q-2", "Paste a Telegram token, or Enter to skip"),
			msg("system-3", "Telegram token received.", "system"),
			msg("user-onboard-4", "(skipped)"),
		];
		expect(settleSetupTranscript(before).map((m) => m.id)).toEqual(["setup-q-2", "system-3", "user-onboard-4"]);
	});

	test("a transcript with no setup cards comes back as it was", () => {
		const before = [msg("a", "hello"), msg("b", "/skip all")];
		expect(settleSetupTranscript(before)).toEqual(before);
	});
});
