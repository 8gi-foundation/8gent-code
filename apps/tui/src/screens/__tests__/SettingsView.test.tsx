/**
 * SettingsView tests.
 *
 * The stateful view owns hooks (useState + useInput) that cannot run outside
 * an Ink render context, and the codebase has no ink-testing-library. So, as
 * with the other __tests__ in apps/tui, we target the pure surfaces the view
 * is built from:
 *
 *   - field registry: every field has a description, a kind, and a get/set
 *     pair that round-trips through DEFAULT_SETTINGS
 *   - alignment: label column width and padding
 *   - footer hints: only mention Left/Right where they act
 *   - edit-buffer state machine: select-all on entry, in-place editing
 *   - validation routing: numbers and text produce the rule message
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../../../../../packages/settings/index.js";
import {
	type Field,
	LABEL_COLUMN_WIDTH,
	SETTINGS_CATEGORIES,
	SettingsView,
	beginEditState,
	browseHint,
	displaySettingsPath,
	editHint,
	editReducer,
	editSeed,
	editSegments,
	formatValue,
	labelColumnWidth,
	padLabel,
	validateFieldInput,
} from "../SettingsView";

const ALL_FIELDS: Field[] = SETTINGS_CATEGORIES.flatMap((c) => c.fields);

function fieldById(id: string): Field {
	const f = ALL_FIELDS.find((x) => x.id === id);
	if (!f) throw new Error(`no field ${id}`);
	return f;
}

describe("SettingsView export", () => {
	test("exports the component", () => {
		expect(typeof SettingsView).toBe("function");
	});
});

describe("field registry", () => {
	test("has the five categories with the documented field counts", () => {
		const counts = SETTINGS_CATEGORIES.map((c) => [c.label, c.fields.length]);
		expect(counts).toEqual([
			["Voice", 7],
			["Performance", 2],
			["Models", 6],
			["Providers", 4],
			["UI", 4],
		]);
	});

	test("every field has a unique id, a label, and a description", () => {
		const ids = new Set<string>();
		for (const f of ALL_FIELDS) {
			expect(f.id.length).toBeGreaterThan(0);
			expect(f.label.length).toBeGreaterThan(0);
			expect(f.description.length).toBeGreaterThan(0);
			expect(ids.has(f.id)).toBe(false);
			ids.add(f.id);
		}
	});

	test("every field reads a defined value from DEFAULT_SETTINGS", () => {
		for (const f of ALL_FIELDS) {
			expect(f.get(DEFAULT_SETTINGS)).toBeDefined();
		}
	});

	test("every number field has a step that fits its range and a default inside it", () => {
		for (const f of ALL_FIELDS) {
			if (f.kind !== "number") continue;
			expect(f.min).toBeLessThan(f.max);
			expect(f.step).toBeGreaterThan(0);
			expect(f.step).toBeLessThanOrEqual(f.max - f.min);
			const v = Number(f.get(DEFAULT_SETTINGS));
			expect(v).toBeGreaterThanOrEqual(f.min);
			expect(v).toBeLessThanOrEqual(f.max);
		}
	});

	test("every select field's default is one of its options", () => {
		for (const f of ALL_FIELDS) {
			if (f.kind !== "select") continue;
			expect(f.options).toContain(String(f.get(DEFAULT_SETTINGS)));
		}
	});

	test("every text field's default passes its own validation rule", () => {
		for (const f of ALL_FIELDS) {
			if (f.kind !== "text") continue;
			const result = validateFieldInput(f, String(f.get(DEFAULT_SETTINGS)));
			expect(result.ok).toBe(true);
		}
	});

	test("toggle fields flip and round-trip without touching other keys", () => {
		for (const f of ALL_FIELDS) {
			if (f.kind !== "toggle") continue;
			const before = f.get(DEFAULT_SETTINGS);
			const next = f.set(DEFAULT_SETTINGS, !before);
			expect(f.get(next)).toBe(!before);
			expect(next).not.toBe(DEFAULT_SETTINGS);
			expect(f.get(f.set(next, before))).toBe(before);
			expect(JSON.stringify(f.set(next, before))).toBe(JSON.stringify(DEFAULT_SETTINGS));
		}
	});

	test("select fields cycle through every option and back", () => {
		for (const f of ALL_FIELDS) {
			if (f.kind !== "select") continue;
			let s = DEFAULT_SETTINGS;
			const start = String(f.get(s));
			for (let i = 0; i < f.options.length; i++) {
				const idx = f.options.indexOf(String(f.get(s)));
				s = f.set(s, f.options[(idx + 1) % f.options.length]);
			}
			expect(String(f.get(s))).toBe(start);
		}
	});

	test("number fields accept a stepped value and clamp out-of-range writes", () => {
		for (const f of ALL_FIELDS) {
			if (f.kind !== "number") continue;
			const stepped = f.set(DEFAULT_SETTINGS, f.min + f.step);
			expect(f.get(stepped)).toBe(f.min + f.step);
			expect(f.get(f.set(DEFAULT_SETTINGS, f.max + 1))).toBe(f.max);
			expect(f.get(f.set(DEFAULT_SETTINGS, f.min - 1))).toBe(f.min);
		}
	});

	test("text fields store the value that was set", () => {
		for (const f of ALL_FIELDS) {
			if (f.kind !== "text") continue;
			const next = f.set(DEFAULT_SETTINGS, "probe-value");
			expect(f.get(next)).toBe("probe-value");
			expect(f.get(DEFAULT_SETTINGS)).not.toBe("probe-value");
		}
	});
});

describe("alignment", () => {
	test("label column is the longest label plus a two-space gap", () => {
		expect(labelColumnWidth([{ label: "ab" }, { label: "abcd" }])).toBe(6);
	});

	test("shared column width covers every field in every category", () => {
		for (const f of ALL_FIELDS) {
			expect(LABEL_COLUMN_WIDTH).toBeGreaterThanOrEqual(f.label.length + 2);
		}
		expect(LABEL_COLUMN_WIDTH).toBe(Math.max(...ALL_FIELDS.map((f) => f.label.length)) + 2);
	});

	test("padded labels all have the same width so values start in one column", () => {
		const widths = new Set(ALL_FIELDS.map((f) => padLabel(f.label, LABEL_COLUMN_WIDTH).length));
		expect(widths.size).toBe(1);
		expect([...widths][0]).toBe(LABEL_COLUMN_WIDTH);
	});

	test("padLabel never truncates a label wider than the column", () => {
		expect(padLabel("a very long label", 4)).toBe("a very long label");
	});

	test("the rows the issue quoted now separate label and value", () => {
		const rows = ["voice.ttsVoice", "voice.bargeIn", "voice.perAgent.orchestrator"].map((id) => {
			const f = fieldById(id);
			return padLabel(f.label, LABEL_COLUMN_WIDTH) + formatValue(f, f.get(DEFAULT_SETTINGS));
		});
		expect(rows[0]).toBe("TTS voice (fallback)    Bruno");
		expect(rows[1]).toBe("Barge-in                [x]");
		expect(rows[2]).toBe("Orchestrator voice      Bruno");
	});
});

describe("formatValue", () => {
	test("renders toggles as checkboxes and everything else as text", () => {
		const toggle = fieldById("voice.bargeIn");
		const number = fieldById("voice.silenceThresholdMs");
		const text = fieldById("voice.ttsVoice");
		expect(formatValue(toggle, true)).toBe("[x]");
		expect(formatValue(toggle, false)).toBe("[ ]");
		expect(formatValue(number, 2000)).toBe("2000");
		expect(formatValue(text, "Ava")).toBe("Ava");
		expect(formatValue(text, undefined)).toBe("");
	});

	test("editSeed is the raw value, never checkbox framing", () => {
		expect(editSeed(2000)).toBe("2000");
		expect(editSeed("Ava")).toBe("Ava");
		expect(editSeed(undefined)).toBe("");
	});
});

describe("footer hints", () => {
	test("toggle rows do not mention left/right", () => {
		const hint = browseHint(fieldById("voice.bargeIn"));
		expect(hint).toContain("space toggle");
		expect(hint).not.toContain("left/right");
	});

	test("text rows do not mention left/right", () => {
		const hint = browseHint(fieldById("voice.ttsVoice"));
		expect(hint).toContain("e edit");
		expect(hint).not.toContain("left/right");
	});

	test("select rows say left/right cycle", () => {
		expect(browseHint(fieldById("performance.mode"))).toContain("left/right cycle");
	});

	test("number rows name the step left/right adjusts by", () => {
		expect(browseHint(fieldById("voice.silenceThresholdMs"))).toContain("left/right adjust by 100");
		expect(browseHint(fieldById("ui.thinkingVisualiser.boredomThresholdMs"))).toContain(
			"left/right adjust by 1000",
		);
	});

	test("every browse hint mentions help and close", () => {
		for (const f of ALL_FIELDS) {
			const hint = browseHint(f);
			expect(hint).toContain("? help");
			expect(hint).toContain("q close");
		}
		expect(browseHint(undefined)).toContain("up/down navigate");
	});

	test("edit hint changes once the selection collapses", () => {
		const f = fieldById("voice.silenceThresholdMs");
		const all = beginEditState("2000");
		expect(editHint(f, all)).toContain("type to replace");
		expect(editHint(f, all)).toContain("500-5000");
		const cursor = editReducer(all, { type: "left" });
		expect(editHint(f, cursor)).toContain("type to insert");
	});

	test("url edit hint names the rule", () => {
		const f = fieldById("providers.ollama.baseURL");
		expect(editHint(f, beginEditState("http://x"))).toContain("http(s) URL");
	});
});

describe("edit-buffer state machine", () => {
	test("begins with the whole value selected", () => {
		expect(beginEditState("2000")).toEqual({
			buffer: "2000",
			cursor: 4,
			selectAll: true,
			error: null,
		});
	});

	test("typing while selected replaces the value (no more 2000abc)", () => {
		let s = beginEditState("2000");
		s = editReducer(s, { type: "char", text: "a" });
		expect(s.buffer).toBe("a");
		expect(s.selectAll).toBe(false);
		s = editReducer(s, { type: "char", text: "b" });
		expect(s.buffer).toBe("ab");
		expect(s.cursor).toBe(2);
	});

	test("backspace while selected clears the value", () => {
		const s = editReducer(beginEditState("2000"), { type: "backspace" });
		expect(s).toEqual({ buffer: "", cursor: 0, selectAll: false, error: null });
	});

	test("left collapses the selection to just before the last character", () => {
		const s = editReducer(beginEditState("2000"), { type: "left" });
		expect(s.selectAll).toBe(false);
		expect(s.cursor).toBe(3);
		const typed = editReducer(s, { type: "char", text: "5" });
		expect(typed.buffer).toBe("20050");
	});

	test("right and end collapse to the end; home collapses to the start", () => {
		expect(editReducer(beginEditState("2000"), { type: "right" }).cursor).toBe(4);
		expect(editReducer(beginEditState("2000"), { type: "end" }).cursor).toBe(4);
		expect(editReducer(beginEditState("2000"), { type: "home" }).cursor).toBe(0);
	});

	test("in-place editing inserts at the cursor and backspaces before it", () => {
		let s = editReducer(beginEditState("Ava"), { type: "home" });
		s = editReducer(s, { type: "char", text: "X" });
		expect(s.buffer).toBe("XAva");
		s = editReducer(s, { type: "right" });
		s = editReducer(s, { type: "backspace" });
		expect(s.buffer).toBe("Xva");
		expect(s.cursor).toBe(1);
	});

	test("cursor never leaves the buffer bounds", () => {
		let s = editReducer(beginEditState("ab"), { type: "home" });
		s = editReducer(s, { type: "left" });
		expect(s.cursor).toBe(0);
		s = editReducer(s, { type: "backspace" });
		expect(s.buffer).toBe("ab");
		s = editReducer(s, { type: "end" });
		s = editReducer(s, { type: "right" });
		expect(s.cursor).toBe(2);
	});

	test("any edit key clears a standing validation error", () => {
		const errored = { ...beginEditState("abc"), selectAll: false, error: "Enter a number" };
		expect(editReducer(errored, { type: "char", text: "1" }).error).toBeNull();
		expect(editReducer(errored, { type: "left" }).error).toBeNull();
	});

	test("segments highlight the whole value when selected and one cell otherwise", () => {
		expect(editSegments(beginEditState("2000"))).toEqual({ before: "", at: "2000", after: "" });
		expect(editSegments(beginEditState(""))).toEqual({ before: "", at: " ", after: "" });
		const mid = { buffer: "2000", cursor: 2, selectAll: false, error: null };
		expect(editSegments(mid)).toEqual({ before: "20", at: "0", after: "0" });
		const end = { buffer: "2000", cursor: 4, selectAll: false, error: null };
		expect(editSegments(end)).toEqual({ before: "2000", at: " ", after: "" });
	});
});

describe("validateFieldInput", () => {
	test("number field: abc is rejected with the range rule", () => {
		const f = fieldById("voice.silenceThresholdMs");
		expect(validateFieldInput(f, "abc")).toEqual({
			ok: false,
			message: "Enter a whole number between 500 and 5000",
		});
		expect(validateFieldInput(f, "2000abc").ok).toBe(false);
		expect(validateFieldInput(f, "9999").ok).toBe(false);
		expect(validateFieldInput(f, "1500")).toEqual({ ok: true, value: 1500 });
	});

	test("voice field: empty is rejected, a name is trimmed", () => {
		const f = fieldById("voice.ttsVoice");
		expect(validateFieldInput(f, "")).toEqual({
			ok: false,
			message: "Enter a macOS voice name, e.g. Ava",
		});
		expect(validateFieldInput(f, " Samantha ")).toEqual({ ok: true, value: "Samantha" });
	});

	test("provider and model fields reject spaces", () => {
		expect(validateFieldInput(fieldById("models.tabs.qa.provider"), "my provider")).toEqual({
			ok: false,
			message: "Enter a provider name with no spaces",
		});
		expect(validateFieldInput(fieldById("models.tabs.qa.model"), "a b")).toEqual({
			ok: false,
			message: "Enter a model id with no spaces",
		});
	});

	test("baseURL fields require http or https", () => {
		const f = fieldById("providers.openrouter.baseURL");
		expect(validateFieldInput(f, "openrouter.ai")).toEqual({
			ok: false,
			message: "Enter a URL starting with http:// or https://",
		});
		expect(validateFieldInput(f, "https://openrouter.ai/api/v1").ok).toBe(true);
	});

	test("toggle and select pass through untouched", () => {
		expect(validateFieldInput(fieldById("voice.bargeIn"), "x")).toEqual({ ok: true, value: "x" });
		expect(validateFieldInput(fieldById("performance.mode"), "lite")).toEqual({
			ok: true,
			value: "lite",
		});
	});
});

describe("displaySettingsPath", () => {
	test("collapses the home directory to ~", () => {
		expect(displaySettingsPath("/home/op/.8gent/settings.json", "/home/op")).toBe(
			"~/.8gent/settings.json",
		);
	});

	test("leaves paths outside home alone", () => {
		expect(displaySettingsPath("/tmp/x/settings.json", "/home/op")).toBe("/tmp/x/settings.json");
		expect(displaySettingsPath("/tmp/x/settings.json", "")).toBe("/tmp/x/settings.json");
	});
});
