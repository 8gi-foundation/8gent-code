/**
 * First-run copy and the chat's name question (intro audit nits 8-10, #3026).
 *
 * - The welcome lists only what detection found, never a column of misses.
 * - Model ids are shortened and listed one per line under one label.
 * - The name question is asked in chat only when the name is really missing,
 *   and the answer is stored in the profile instead of going to the model.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OnboardingManager, asName, foundOnMachine, shortModelName } from "./onboarding";

let home: string;
let prevHome: string | undefined;

beforeAll(() => {
	prevHome = process.env.HOME;
	home = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-onboarding-copy-"));
	process.env.HOME = home;
});

afterAll(() => {
	process.env.HOME = prevHome;
	fs.rmSync(home, { recursive: true, force: true });
});

function freshManager(): OnboardingManager {
	fs.rmSync(path.join(home, ".8gent"), { recursive: true, force: true });
	return new OnboardingManager(home);
}

describe("foundOnMachine", () => {
	test("nothing found: no block at all, not a list of misses", () => {
		const m = freshManager();
		expect(foundOnMachine(m.getUser())).toBe("");
		const welcome = m.getNextQuestion()?.question ?? "";
		expect(welcome).not.toContain("not detected");
		expect(welcome).not.toContain("none found");
		expect(welcome).toContain("Press Enter to begin.");
	});

	test("only the finds, in label and value columns, models with a hanging indent", () => {
		const m = freshManager();
		m.applyAutoDetected({
			name: "Ada Lovelace",
			email: null,
			ollamaModels: [
				"qwen3.8:27b-mlx",
				"hf.co/AtlaAI/Selene-1-Mini-Llama-3.1-8B-GGUF:Q4_K_M",
				"llama3.2:3b",
				"gemma3:4b",
				"phi4:14b",
			],
			githubUsername: null,
			preferredProvider: "ollama",
			hasPython: false,
			hasKittenTTS: false,
		});
		const block = foundOnMachine(m.getUser());
		const lines = block.trimEnd().split("\n");
		expect(lines[0]).toBe("Found on this machine:");
		expect(lines).toContain("  Name      Ada Lovelace");
		expect(lines).toContain("  Provider  ollama");
		expect(lines).toContain("  Models    qwen3.8:27b-mlx");
		expect(block).not.toContain("GitHub");
		expect(block).not.toContain("hf.co/");
		expect(lines.at(-1)).toBe("            and 2 more");
		// Every value starts in the same column.
		for (const l of lines.slice(1)) {
			expect(l[12]).not.toBe(" ");
			expect(l.slice(0, 12).trimEnd().length).toBeLessThan(12);
		}
		for (const l of lines) expect(l.length).toBeLessThanOrEqual(46);
	});
});

describe("shortModelName", () => {
	test("drops the registry and org, keeps the tag, clips long names", () => {
		expect(shortModelName("qwen3.8:27b-mlx")).toBe("qwen3.8:27b-mlx");
		const s = shortModelName("hf.co/AtlaAI/Selene-1-Mini-Llama-3.1-8B-GGUF:Q4_K_M");
		expect(s.startsWith("Selene-1-Mini")).toBe(true);
		expect(s.length).toBeLessThanOrEqual(28);
	});
});

describe("the name question", () => {
	test("identity step: the placeholder says what to type, the default is offered only when real", () => {
		const m = freshManager();
		m.processAnswer("ok");
		const q = m.getNextQuestion();
		expect(q?.step).toBe("identity");
		expect(q?.placeholder).toBe("Your name");
		expect(q?.question).toBe("What should I call you?");
		expect(q?.question).not.toContain("not detected");
	});

	test("asName accepts names and refuses requests", () => {
		expect(asName("James")).toBe("James");
		expect(asName("  Mary-Jane O'Neill ")).toBe("Mary-Jane O'Neill");
		expect(asName("Seán")).toBe("Seán");
		expect(asName("fix the failing tests")).toBeNull();
		expect(asName("what time is it?")).toBeNull();
		expect(asName("/help")).toBeNull();
		expect(asName("run bun test in packages/decide please")).toBeNull();
		expect(asName("")).toBeNull();
	});

	test("asked in chat only when the name is missing (#3026)", () => {
		const m = freshManager();
		m.skipAll();
		expect(m.getClarificationArea()).toBe("identity");
		m.applyAutoDetected({
			name: "Ada",
			email: null,
			ollamaModels: [],
			githubUsername: null,
			preferredProvider: null,
			hasPython: false,
			hasKittenTTS: false,
		});
		expect(m.getClarificationArea()).toBeNull();
		expect(m.getClarificationQuestion()).toBeNull();
	});

	test("the answer is stored in the profile and the question is not asked again", () => {
		const m = freshManager();
		m.skipAll();
		expect(m.answerNameClarification("James")).toBe("James");
		expect(m.getUser().identity.name).toBe("James");
		expect(m.getClarificationArea()).toBeNull();
		const onDisk = JSON.parse(fs.readFileSync(path.join(home, ".8gent", "user.json"), "utf-8"));
		expect(onDisk.identity.name).toBe("James");
		// A fresh manager (next launch) reads it back and does not ask.
		expect(new OnboardingManager(home).getClarificationArea()).toBeNull();
	});

	test("a request typed instead is not stored as a name", () => {
		const m = freshManager();
		m.skipAll();
		expect(m.answerNameClarification("fix the failing tests")).toBeNull();
		expect(m.getUser().identity.name).toBeFalsy();
	});
});
