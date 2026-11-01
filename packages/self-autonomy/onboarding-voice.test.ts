/**
 * Onboarding voice steps: the recommended and default choice is the natural
 * system voice. KittenTTS (a small local model) is an explicit opt-in only.
 */

import { describe, expect, test } from "bun:test";
import { ONBOARDING_QUESTIONS, type UserConfig } from "./onboarding.js";

function step(name: string) {
	const q = ONBOARDING_QUESTIONS.find((x) => x.step === name);
	if (!q) throw new Error(`missing onboarding step ${name}`);
	return q;
}

function blankUser(): UserConfig {
	return {
		completedSteps: [],
		preferences: { voice: { enabled: false, engine: null, voiceId: null } },
	} as unknown as UserConfig;
}

describe("onboarding voice defaults", () => {
	test("naming the agent does not assign a KittenTTS voice", () => {
		const user = step("voice").processor("", blankUser());
		expect(user.preferences.voice.voiceId).toBeNull();
	});

	test("voice services: the first (default) choice keeps system voices", () => {
		const q = step("voice-services");
		const first = q.choices?.[0];
		expect(first?.description ?? "").toMatch(/recommended/i);
		const user = q.processor(first?.value ?? "", blankUser());
		expect(user.preferences.voice.engine).toBe("system");
		// KittenTTS is still offered, but not as the recommendation.
		const kitten = q.choices?.find((c) => /kitten/i.test(`${c.label} ${c.description}`));
		expect(kitten).toBeDefined();
		expect(kitten?.description ?? "").not.toMatch(/recommended/i);
	});

	test("voice picker: the recommended first choice is the natural system voice", () => {
		const q = step("voice-picker");
		const first = q.choices?.[0];
		expect(first?.description ?? "").toMatch(/recommended/i);
		expect(first?.label ?? "").not.toMatch(/bruno/i);
		const user = q.processor(first?.value ?? "", blankUser());
		expect(user.preferences.voice.engine).toBe("system");
		// null = let the resolver pick the most natural installed voice.
		expect(user.preferences.voice.voiceId).toBeNull();
	});

	test("voice picker: pressing Enter with no answer picks the system voice", () => {
		const user = step("voice-picker").processor("", blankUser());
		expect(user.preferences.voice.engine).toBe("system");
	});

	test("voice picker: no option other than the first is marked recommended", () => {
		const rest = step("voice-picker").choices?.slice(1) ?? [];
		for (const c of rest) expect(c.description ?? "").not.toMatch(/recommended/i);
	});

	test("voice picker: choosing a KittenTTS voice is an explicit kitten opt-in", () => {
		const q = step("voice-picker");
		const bruno = q.choices?.find((c) => /bruno/i.test(c.label));
		expect(bruno).toBeDefined();
		const user = q.processor(bruno?.value ?? "", blankUser());
		expect(user.preferences.voice.engine).toBe("kitten");
		expect(user.preferences.voice.voiceId).toBe("Bruno");
	});
});
