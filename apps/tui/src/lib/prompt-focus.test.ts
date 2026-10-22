/**
 * 0.20.12 regression: the prompt went deaf in every view but chat and onboarding.
 * The ViewMode union is read from app.tsx itself, so a new view added later is
 * tested here without anyone remembering to list it.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	ESC_RETURNS_LINE,
	KEYBOARD_VIEWS,
	type PromptFocusState,
	mayAutoOpenProviderPicker,
	promptIsLive,
} from "./prompt-focus.js";

const src = fs.readFileSync(path.join(import.meta.dir, "../app.tsx"), "utf8");
const union = src.match(/type ViewMode =([^;]+);/)?.[1] ?? "";
const VIEW_MODES = [...union.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);

const idle: PromptFocusState = {
	viewMode: "chat",
	tabBodyShown: false,
	isBubbleNavMode: false,
	paletteOpen: false,
	djKeys: false,
	onboardingSelectChoices: false,
};

describe("prompt focus fails open", () => {
	test("the ViewMode union was read", () => {
		expect(VIEW_MODES.length).toBeGreaterThanOrEqual(16);
		expect(VIEW_MODES).toContain("chat");
	});

	test("every viewMode keeps the prompt live unless it is a keyboard-owning view", () => {
		for (const viewMode of VIEW_MODES) {
			expect([viewMode, promptIsLive({ ...idle, viewMode })]).toEqual([
				viewMode,
				!KEYBOARD_VIEWS.has(viewMode),
			]);
		}
	});

	test("the keyboard-owning list is exactly the views that draw their own screen", () => {
		expect([...KEYBOARD_VIEWS].sort()).toEqual([
			"keys",
			"model-select",
			"provider-select",
			"session-picker",
			"session-tree",
			"theme-select",
		]);
		for (const v of KEYBOARD_VIEWS) expect(VIEW_MODES).toContain(v);
	});

	test("palette, bubble nav, DJ keys, a drawn tab body and onboarding choices own the keys", () => {
		expect(promptIsLive({ ...idle, paletteOpen: true })).toBeFalse();
		expect(promptIsLive({ ...idle, isBubbleNavMode: true })).toBeFalse();
		expect(promptIsLive({ ...idle, djKeys: true })).toBeFalse();
		expect(promptIsLive({ ...idle, tabBodyShown: true })).toBeFalse();
		expect(
			promptIsLive({ ...idle, viewMode: "onboarding", onboardingSelectChoices: true }),
		).toBeFalse();
		expect(promptIsLive({ ...idle, viewMode: "onboarding" })).toBeTrue();
	});

	test("an unknown future view fails open", () => {
		expect(promptIsLive({ ...idle, viewMode: "some-new-view" })).toBeTrue();
	});

	test("every keyboard-owning view is drawn with the way back, and Esc closes it to chat", () => {
		expect(ESC_RETURNS_LINE).toBe("Esc returns to the prompt");
		expect(src).toContain("<MutedText>{ESC_RETURNS_LINE}</MutedText>");
		for (const v of KEYBOARD_VIEWS) {
			// every owning view's close/cancel path returns to chat
			expect(src).toMatch(new RegExp(`case "${v}"`));
		}
		expect(src.match(/onCancel=\{\(\) => setViewMode\("chat"\)\}/g)?.length).toBeGreaterThanOrEqual(
			3,
		);
		expect(src.match(/onClose=\{\(\) => setViewMode\("chat"\)\}/g)?.length).toBeGreaterThanOrEqual(
			3,
		);
	});
});

describe("one keyed provider is not a choice (#4720)", () => {
	test("exactly one keyed hosted provider never auto-opens the picker", () => {
		expect(mayAutoOpenProviderPicker(["minimax"])).toBeFalse();
	});
	test("none or several still may", () => {
		expect(mayAutoOpenProviderPicker([])).toBeTrue();
		expect(mayAutoOpenProviderPicker(["minimax", "openrouter"])).toBeTrue();
	});
	test("app.tsx asks that rule before the automatic setViewMode(provider-select)", () => {
		const i = src.indexOf("mayAutoOpenProviderPicker(hostedKeyedProviders())");
		const j = src.indexOf('if (viewMode === "chat") setViewMode("provider-select");');
		expect(i).toBeGreaterThan(0);
		expect(j).toBeGreaterThan(i);
	});
});
