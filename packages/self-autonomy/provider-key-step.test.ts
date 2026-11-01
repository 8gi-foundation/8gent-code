/**
 * First-run setup asks for a hosted provider's key inside the app (#4703):
 * masked input, saved through setKeyInFile, then on with that provider and no
 * restart. The key is never stored in the profile or echoed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { answerFromInput } from "../../apps/tui/src/lib/onboarding-chat";
import { ONBOARDING_QUESTIONS, OnboardingManager } from "./onboarding";

let home: string;
let prevHome: string | undefined;
const KEY = "sk-or-test-0123456789abcdef";

beforeAll(() => {
	prevHome = process.env.HOME;
	home = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-provider-key-"));
	process.env.HOME = home;
});
afterAll(() => {
	process.env.HOME = prevHome;
	fs.rmSync(home, { recursive: true, force: true });
});

function atProviderChoice(env: Record<string, string | undefined>, saved: Array<[string, string]>) {
	fs.rmSync(path.join(home, ".8gent"), { recursive: true, force: true });
	const active: string[] = [];
	const m = new OnboardingManager(home, {
		env,
		saveKey: (name, value) => {
			if (value.length < 8) return "That value is too short to be a real key. Nothing was saved.";
			saved.push([name, value]);
			return null;
		},
		providerManager: () =>
			({
				setActiveProvider: (p: string) => active.push(`provider:${p}`),
				setActiveModel: (x: string) => active.push(`model:${x}`),
				enableProvider: () => {},
			}) as never,
	});
	for (const q of ONBOARDING_QUESTIONS) {
		if (q.step === "provider-choice") break;
		m.getUser().completedSteps.push(q.step);
	}
	expect(m.getNextQuestion()?.step).toBe("provider-choice");
	return { m, active };
}

describe("provider key step", () => {
	test("picking OpenRouter with no key asks for it, masked, and never echoes it", () => {
		const saved: Array<[string, string]> = [];
		const { m, active } = atProviderChoice({}, saved);
		const r = m.processAnswer("openrouter");
		expect(r.success).toBe(true);
		const q = r.nextQuestion;
		expect(q?.step).toBe("provider-key");
		expect(q?.kind).toBe("secret");
		expect(q?.question).toContain("OpenRouter");
		expect(active).toContain("model:auto:free");

		// The chat shows a fixed line, never the typed key.
		expect(answerFromInput(q as never, KEY)).toEqual({ value: KEY, echo: "Key entered" });

		const done = m.processAnswer(KEY);
		expect(done.success).toBe(true);
		expect(saved).toEqual([["OPENROUTER_API_KEY", KEY]]);
		expect(m.getNextQuestion()?.step).not.toBe("provider-key");
		expect(m.takeKeyError()).toBeNull();
		// Nothing the profile writes to disk carries the key.
		const profile = fs.readFileSync(path.join(home, ".8gent", "user.json"), "utf-8");
		expect(profile).not.toContain(KEY);
	});

	test("the key is live in this process env straight away", () => {
		const env: Record<string, string | undefined> = {};
		const { m } = atProviderChoice(env, []);
		m.processAnswer("openrouter");
		m.processAnswer(KEY);
		expect(env.OPENROUTER_API_KEY).toBe(KEY);
	});

	test("MiniMax is offered by name, asks for MINIMAX_API_KEY, then picks a model from its live list", async () => {
		const saved: Array<[string, string]> = [];
		const { m, active } = atProviderChoice({}, saved);
		const choices = m.getNextQuestion()?.choices?.map((c) => c.value);
		expect(choices).toContain("minimax");
		expect(choices).toContain("openrouter");
		const r = m.processAnswer("minimax");
		expect(r.nextQuestion?.question).toContain("MiniMax");
		m.processAnswer(KEY);
		expect(saved).toEqual([["MINIMAX_API_KEY", KEY]]);
		const picked = await m.pickModelAfterKey(async () => ["MiniMax-M2", "other"]);
		expect(picked).toMatchObject({ provider: "minimax", model: "MiniMax-M2" });
		expect(active).toContain("model:MiniMax-M2");
		expect(await m.pickModelAfterKey()).toBeNull();
	});

	test("a refused key says why and asks again; Enter skips", () => {
		const { m } = atProviderChoice({}, []);
		m.processAnswer("openrouter");
		const again = m.processAnswer("short");
		expect(again.nextQuestion?.step).toBe("provider-key");
		expect(m.takeKeyError()).toContain("too short");
		expect(m.takeKeyError()).toBeNull();
		const skipped = m.processAnswer("");
		expect(skipped.nextQuestion?.step).not.toBe("provider-key");
	});

	test("with a key already set, or a local pick, or Decide later, the key is never asked", () => {
		const a = atProviderChoice({ OPENROUTER_API_KEY: KEY }, []);
		expect(a.m.processAnswer("openrouter").nextQuestion?.step).not.toBe("provider-key");
		const b = atProviderChoice({}, []);
		expect(b.m.processAnswer("later").nextQuestion?.step).not.toBe("provider-key");
	});
});
