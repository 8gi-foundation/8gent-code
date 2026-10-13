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
import { providerChoiceScreen } from "./local-servers";
import { KEYS_FILE_DISPLAY, LMSTUDIO_RECOMMENDED, OLLAMA_RECOMMENDED } from "./model-recipes";
import {
	ONBOARDING_QUESTIONS,
	OnboardingManager,
	asName,
	foundOnMachine,
	providerInstallHint,
	shortModelName,
} from "./onboarding";

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

	test("only the finds, in label and value columns", () => {
		const m = freshManager();
		m.applyAutoDetected({
			name: "Ada Lovelace",
			email: null,
			ollamaModels: [],
			githubUsername: "ada",
			preferredProvider: null,
			hasPython: false,
			hasKittenTTS: false,
		});
		const lines = foundOnMachine(m.getUser()).trimEnd().split("\n");
		expect(lines).toEqual([
			"Found on this machine:",
			"  Name      Ada Lovelace",
			"  GitHub    ada",
		]);
	});

	test("no server or model rows: only Ollama is known at the welcome (#4221)", () => {
		const m = freshManager();
		m.applyAutoDetected({
			name: "Ada Lovelace",
			email: null,
			ollamaModels: [
				"llamacpp:c97eb11d70b1acdc88af01eef566c1fe4f7fbe93eb1afc06871132f293ff425a",
				"qwen3.5:9b",
			],
			githubUsername: null,
			preferredProvider: "ollama",
			hasPython: false,
			hasKittenTTS: false,
		});
		const block = foundOnMachine(m.getUser());
		expect(block).toContain("Ada Lovelace");
		expect(block).not.toContain("Provider");
		expect(block).not.toContain("Models");
		expect(block).not.toContain("llamacpp:");
		expect(block).not.toContain("ollama");
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

describe("on-screen words (#4219)", () => {
	const shown = ONBOARDING_QUESTIONS.flatMap((q) => [
		q.question,
		q.placeholder ?? "",
		...(q.choices ?? []).flatMap((c) => [c.label, c.description ?? ""]),
	]);

	test("the a-word is never on a setup screen: it is written 8gent", () => {
		for (const text of shown) expect(text).not.toMatch(/\bagents?\b/i);
		const byStep = Object.fromEntries(ONBOARDING_QUESTIONS.map((q) => [q.step, q.question]));
		expect(byStep["agent-name-orchestrator"]).toStartWith("Name your Orchestrator 8gent.");
		expect(byStep["agent-name-engineer"]).toStartWith("Name your Engineer 8gent.");
		expect(byStep["agent-name-qa"]).toStartWith("Name your QA 8gent.");
		expect(byStep["voice-picker"]).toBe("Pick a voice for your 8gent.");
	});

	test("no em dash on a setup screen", () => {
		for (const text of shown) expect(text).not.toContain("\u2014");
	});

	test("the 8gent name step keeps Eight on Enter and says so", () => {
		const q = ONBOARDING_QUESTIONS.find((x) => x.step === "voice");
		expect(q?.default).toBe("Eight");
		expect(q?.placeholder).toBe("A name, or Enter to keep Eight");
	});
});

describe("one model per server, one key file (#4220)", () => {
	const platforms = ["darwin", "linux", "win32"];

	test("every Ollama hint pulls the recommended model, with its size, from ollama.com", () => {
		for (const p of platforms) {
			const hint = providerInstallHint("ollama", p);
			expect(hint).toContain(
				`ollama pull ${OLLAMA_RECOMMENDED.pull}\` (${OLLAMA_RECOMMENDED.size})`,
			);
			expect(hint).toContain("ollama.com");
			expect(hint).not.toContain("ollama.ai");
			expect(hint).not.toContain("qwen3.6");
		}
		expect(OLLAMA_RECOMMENDED.pull).toBe("qwen3.5");
	});

	test("every LM Studio hint loads the recommended model, with its size", () => {
		for (const p of platforms) {
			const hint = providerInstallHint("lmstudio", p);
			expect(hint).toContain(`\`${LMSTUDIO_RECOMMENDED.model}\` (${LMSTUDIO_RECOMMENDED.size})`);
		}
	});

	test("the cloud choice names keys.env, the file 8gent keys opens", () => {
		const screen = providerChoiceScreen([], "darwin");
		const cloud = screen.choices.find((c) => c.value === "openrouter");
		expect(cloud?.description).toContain(KEYS_FILE_DISPLAY);
		expect(cloud?.description).not.toContain("~/.8gent/.env");
		expect(cloud?.description?.length ?? 99).toBeLessThanOrEqual(56);
	});
});
