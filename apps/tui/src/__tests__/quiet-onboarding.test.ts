/**
 * First launch is quiet, and it never eats the user's first question.
 *
 * The behaviour this pins down, from the first-run audit:
 *   - A brand new user used to get three system blocks before they could type:
 *     a welcome, a "before we begin" preamble, and an auto-detect table whose
 *     four rows mostly read "not detected".
 *   - Worse, the modal flag bled: a real question typed at the prompt
 *     ("In one short sentence, what can you help me with here?") was fed to
 *     processAnswer and came back as "Got it, your name is saved, James."
 *     The question itself was dropped.
 *
 * Two layers here, both against the real code the App calls:
 *   1. buildFirstRunGreeting + OnboardingManager - what a first launch says,
 *      and that /onboard still walks the same question list one at a time.
 *   2. shouldOnboardingConsumeInput - who owns a submission, decided by what
 *      is on screen rather than by a flag.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	buildFirstRunGreeting,
	OnboardingManager,
	type UserConfig,
} from "../../../../packages/self-autonomy/onboarding";
import {
	formatOnboardingQuestion,
	shouldOnboardingConsumeInput,
} from "../lib/onboarding-input";

// ---------------------------------------------------------------------------
// Isolated home so nothing here reads or writes the real ~/.8gent/user.json.
// ---------------------------------------------------------------------------

let tmpHome: string;
let realHome: string | undefined;

beforeEach(() => {
	realHome = process.env.HOME;
	tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "quiet-onboarding-"));
	process.env.HOME = tmpHome;
});

afterEach(() => {
	process.env.HOME = realHome ?? os.homedir();
	fs.rmSync(tmpHome, { recursive: true, force: true });
});

function freshManager(): OnboardingManager {
	return new OnboardingManager(tmpHome);
}

/** The rows the old first paint printed. None of them may come back. */
const AUTO_DETECT_MARKERS = [
	"Here's what I detected",
	"not detected",
	"Name:",
	"Email:",
	"GitHub:",
	"Provider:",
	"Models:",
];

describe("first launch shows two lines, not three blocks", () => {
	test("greeting has no auto-detect table and no 'not detected' rows", () => {
		const mgr = freshManager();
		expect(mgr.needsOnboarding()).toBe(true);
		expect(mgr.needsFirstRunGreeting()).toBe(true);

		const greeting = mgr.getFirstRunGreeting();
		for (const marker of AUTO_DETECT_MARKERS) {
			expect(greeting).not.toContain(marker);
		}
	});

	test("greeting is at most two lines", () => {
		const greeting = freshManager().getFirstRunGreeting();
		expect(greeting.split("\n").filter((l) => l.trim() !== "").length).toBeLessThanOrEqual(2);
	});

	test("greeting says what this is and points at /onboard", () => {
		const greeting = freshManager().getFirstRunGreeting();
		expect(greeting).toContain("8gent Code");
		expect(greeting).toContain("/onboard");
	});

	test("greeting drops the 'before we begin' preamble entirely", () => {
		const greeting = freshManager().getFirstRunGreeting();
		expect(greeting).not.toContain("Before we begin");
		expect(greeting).not.toContain("I'd like to learn about you");
	});

	test("nothing real detected means nothing is claimed", () => {
		const greeting = freshManager().getFirstRunGreeting();
		expect(greeting).not.toContain("Set up for");
	});

	test("a real detection gets one line, still inside two lines", () => {
		const mgr = freshManager();
		mgr.applyAutoDetected({
			name: "James Spalding",
			email: "james@example.test",
			ollamaModels: ["qwen3:14b"],
			githubUsername: "jamesspalding",
			preferredProvider: "ollama",
			hasPython: true,
			hasKittenTTS: false,
		});

		const greeting = mgr.getFirstRunGreeting();
		expect(greeting).toContain("James Spalding");
		expect(greeting).toContain("ollama");
		expect(greeting.split("\n").filter((l) => l.trim() !== "").length).toBeLessThanOrEqual(2);
		for (const marker of AUTO_DETECT_MARKERS) {
			expect(greeting).not.toContain(marker);
		}
	});

	test("greeting is shown once per machine, then stays quiet", () => {
		const first = freshManager();
		expect(first.needsFirstRunGreeting()).toBe(true);
		first.markFirstRunGreeted();
		expect(first.needsFirstRunGreeting()).toBe(false);

		// A second launch reads the same persisted config.
		const second = freshManager();
		expect(second.needsFirstRunGreeting()).toBe(false);
		// Onboarding itself is still pending - the user can still run /onboard.
		expect(second.needsOnboarding()).toBe(true);
	});

	test("buildFirstRunGreeting is pure and honest about empty config", () => {
		const empty = {
			identity: { name: null },
			integrations: { github: { username: null } },
			preferences: { model: { provider: null } },
		} as unknown as UserConfig;
		const greeting = buildFirstRunGreeting(empty);
		expect(greeting.split("\n")).toHaveLength(2);
		expect(greeting).not.toContain("Set up for");
	});
});

describe("a typed question while onboarding is pending reaches the agent", () => {
	const question = "In one short sentence, what can you help me with here?";

	test("onboarding pending but not started: the agent gets it", () => {
		// This is the first-launch state after the change: needsOnboarding() is
		// true, but the flow was never opened, so nothing is on screen to answer.
		expect(
			shouldOnboardingConsumeInput({
				showOnboarding: false,
				viewMode: "chat",
				currentQuestion: null,
				input: question,
			}),
		).toBe(false);
	});

	test("flow flagged on but the user is looking at chat: the agent gets it", () => {
		expect(
			shouldOnboardingConsumeInput({
				showOnboarding: true,
				viewMode: "chat",
				currentQuestion: "What should I call you?",
				input: question,
			}),
		).toBe(false);
	});

	test("onboarding screen up but no question pending: the agent gets it", () => {
		expect(
			shouldOnboardingConsumeInput({
				showOnboarding: true,
				viewMode: "onboarding",
				currentQuestion: null,
				input: question,
			}),
		).toBe(false);
	});

	test("its own question is on screen: onboarding gets the answer", () => {
		expect(
			shouldOnboardingConsumeInput({
				showOnboarding: true,
				viewMode: "onboarding",
				currentQuestion: "What should I call you?",
				input: "James",
			}),
		).toBe(true);
	});

	test("slash commands are never consumed as answers", () => {
		for (const cmd of ["/skip", "/skip all", "/onboard", "/help"]) {
			expect(
				shouldOnboardingConsumeInput({
					showOnboarding: true,
					viewMode: "onboarding",
					currentQuestion: "What should I call you?",
					input: cmd,
				}),
			).toBe(false);
		}
	});

	test("whitespace-only question text does not count as a question on screen", () => {
		expect(
			shouldOnboardingConsumeInput({
				showOnboarding: true,
				viewMode: "onboarding",
				currentQuestion: "   ",
				input: question,
			}),
		).toBe(false);
	});
});

describe("/onboard runs the full flow on demand", () => {
	test("reset then getNextQuestion opens the flow at step one", () => {
		const mgr = freshManager();
		mgr.reset();
		const first = mgr.getNextQuestion();
		expect(first).not.toBeNull();
		expect(mgr.getTotalSteps()).toBeGreaterThan(1);
		// The full flow keeps the auto-detect summary - it is only unprompted
		// first launch that must not show it.
		expect(first?.question).toContain("Here's what I detected");
	});

	test("the flow advances one question at a time", () => {
		const mgr = freshManager();
		mgr.reset();

		const first = mgr.getNextQuestion();
		expect(first).not.toBeNull();

		const afterFirst = mgr.processAnswer("ok");
		expect(afterFirst.success).toBe(true);
		expect(afterFirst.nextQuestion).not.toBeNull();
		expect(afterFirst.nextQuestion?.step).not.toBe(first?.step);

		// Exactly one question is ever outstanding.
		expect(mgr.getNextQuestion()?.step).toBe(afterFirst.nextQuestion?.step);
	});

	test("/skip advances a single question and keeps the rest", () => {
		const mgr = freshManager();
		mgr.reset();
		const first = mgr.getNextQuestion();
		const next = mgr.skipQuestion();
		expect(next).not.toBeNull();
		expect(next?.step).not.toBe(first?.step);
		expect(mgr.needsOnboarding()).toBe(true);
	});

	test("/skip all ends the flow and persists", () => {
		const mgr = freshManager();
		mgr.reset();
		mgr.skipAll();
		expect(mgr.needsOnboarding()).toBe(false);
		expect(mgr.getNextQuestion()).toBeNull();
		expect(freshManager().needsOnboarding()).toBe(false);
	});

	test("answers still persist across managers", () => {
		const mgr = freshManager();
		mgr.reset();
		mgr.processAnswer("ok"); // welcome step
		mgr.processAnswer("James"); // identity step
		expect(freshManager().getUser().identity.name).toBe("James");
	});

	test("reset keeps the greeting spent so /onboard does not re-arm it", () => {
		const mgr = freshManager();
		mgr.markFirstRunGreeted();
		mgr.reset();
		expect(mgr.needsFirstRunGreeting()).toBe(false);
	});

	test("reset clears answers but keeps what the machine told us", () => {
		const mgr = freshManager();
		mgr.applyAutoDetected({
			name: "James Spalding",
			email: "james@example.test",
			ollamaModels: ["qwen3:14b"],
			githubUsername: "jamesspalding",
			preferredProvider: "ollama",
			hasPython: true,
			hasKittenTTS: false,
		});
		mgr.processAnswer("ok"); // welcome summary
		mgr.processAnswer(""); // name: empty keeps the detected one
		mgr.processAnswer("designer"); // role: purely an answer
		mgr.reset();

		// Answers are gone and the flow starts over.
		expect(mgr.getUser().completedSteps).toHaveLength(0);
		expect(mgr.getUser().identity.role).toBeNull();
		expect(mgr.needsOnboarding()).toBe(true);
		// What the machine told us survives, so the summary is not five
		// "not detected" rows about an environment we already read correctly.
		const summary = mgr.getNextQuestion()?.question ?? "";
		expect(summary).toContain("James Spalding");
		expect(summary).toContain("jamesspalding");
		expect(summary).toContain("ollama");
		expect(summary).toContain("qwen3:14b");
		expect(summary).not.toContain("not detected");
		expect(summary).not.toContain("none found");
	});

	test("a choice step tells the user what to type", () => {
		const rendered = formatOnboardingQuestion({
			question: "What best describes you?",
			choices: [
				{ label: "Engineer", value: "engineer", description: "Builder of software" },
				{ label: "Designer", value: "designer", description: "Crafter of interfaces" },
			],
		});
		expect(rendered).toContain("What best describes you?");
		expect(rendered).toContain("engineer");
		expect(rendered).toContain("Engineer");
		expect(rendered).toContain("designer");
	});

	test("a free-text step is rendered unchanged", () => {
		const q = "What should I call you? (default: James)";
		expect(formatOnboardingQuestion({ question: q })).toBe(q);
		expect(formatOnboardingQuestion({ question: q, choices: [] })).toBe(q);
	});

	test("every choice step in the flow is answerable by typing its value", () => {
		const mgr = freshManager();
		mgr.reset();
		let q = mgr.getNextQuestion();
		let guard = 0;
		while (q && guard < 50) {
			if (q.choices && q.choices.length > 0) {
				const rendered = formatOnboardingQuestion(q);
				for (const choice of q.choices) {
					expect(rendered).toContain(choice.value);
				}
			}
			q = mgr.skipQuestion();
			guard++;
		}
		expect(guard).toBeGreaterThan(0);
	});

	test("the voicePicker step contract is untouched", () => {
		const mgr = freshManager();
		mgr.reset();
		// Walk the flow and make sure the voice picker step is still reachable
		// and still declares its own kind. PR #2946 owns its contents.
		let guard = 0;
		let q = mgr.getNextQuestion();
		let sawVoicePicker = false;
		while (q && guard < 50) {
			if (q.step === "voice-picker") {
				sawVoicePicker = true;
				break;
			}
			q = mgr.skipQuestion();
			guard++;
		}
		expect(sawVoicePicker).toBe(true);
	});
});
