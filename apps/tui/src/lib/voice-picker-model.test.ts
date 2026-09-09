/**
 * The picker's keyboard model, kept pure so it can be tested without Ink.
 * The rules that matter to a person: the list never loses your place when
 * you type a filter, a voice is never shown without its group heading, and
 * the highlight starts on the voice you already use.
 */
import { describe, expect, test } from "bun:test";
import type { VoiceCatalog, VoiceEntry } from "../../../../packages/voice/voice-catalog.js";
import {
	buildRows,
	computeRowWindow,
	countVoices,
	initialHighlight,
	initialState,
	matchesFilter,
	reducePicker,
	rowIndexOf,
	sameVoice,
	visibleVoices,
} from "./voice-picker-model.js";

function voice(
	engine: VoiceEntry["engine"],
	id: string,
	over: Partial<VoiceEntry> = {},
): VoiceEntry {
	return {
		engine,
		id,
		name: id,
		hint: "",
		language: null,
		novelty: false,
		...over,
	};
}

const catalog: VoiceCatalog = {
	groups: [
		{
			id: "kitten",
			label: "Kitten, local neural, fastest",
			voices: [
				voice("kitten", "Jasper", { hint: "male" }),
				voice("kitten", "Luna", { hint: "female" }),
			],
		},
		{
			id: "macos",
			label: "Built-in macOS",
			voices: [
				voice("macos", "Daniel", { hint: "English (UK)", language: "en_GB" }),
				voice("macos", "Moira", { hint: "English (Ireland)", language: "en_IE" }),
			],
		},
		{
			id: "fun",
			label: "Fun",
			voices: [voice("macos", "Bells", { hint: "English (US)", language: "en_US", novelty: true })],
		},
	],
	unavailable: [],
	recommended: { engine: "kitten", id: "Jasper" },
};

describe("matchesFilter", () => {
	test("an empty filter keeps everything", () => {
		expect(matchesFilter(voice("kitten", "Jasper"), "")).toBe(true);
		expect(matchesFilter(voice("kitten", "Jasper"), "   ")).toBe(true);
	});

	test("matches the name, the hint and the language code, ignoring case", () => {
		const moira = voice("macos", "Moira", { hint: "English (Ireland)", language: "en_IE" });
		expect(matchesFilter(moira, "moi")).toBe(true);
		expect(matchesFilter(moira, "IRELAND")).toBe(true);
		expect(matchesFilter(moira, "en_ie")).toBe(true);
		expect(matchesFilter(moira, "german")).toBe(false);
	});
});

describe("buildRows", () => {
	test("every group gets a heading and its voices are numbered in order", () => {
		const rows = buildRows(catalog, "");
		expect(rows.filter((r) => r.kind === "heading").length).toBe(3);
		expect(visibleVoices(rows).map((v) => v.name)).toEqual([
			"Jasper",
			"Luna",
			"Daniel",
			"Moira",
			"Bells",
		]);
		const voiceRows = rows.filter((r) => r.kind === "voice");
		expect(voiceRows.map((r) => (r.kind === "voice" ? r.index : -1))).toEqual([0, 1, 2, 3, 4]);
	});

	test("a group with nothing left under the filter is dropped, heading and all", () => {
		const rows = buildRows(catalog, "jasper");
		expect(
			rows.filter((r) => r.kind === "heading").map((r) => (r.kind === "heading" ? r.group : "")),
		).toEqual(["kitten"]);
		expect(visibleVoices(rows).map((v) => v.name)).toEqual(["Jasper"]);
	});

	test("a filter that matches nothing leaves no rows", () => {
		expect(buildRows(catalog, "zzzz")).toEqual([]);
	});

	test("counts what the header shows", () => {
		expect(countVoices(catalog)).toBe(5);
	});
});

describe("where the highlight starts", () => {
	test("on the voice already in use", () => {
		const voices = visibleVoices(buildRows(catalog, ""));
		expect(initialHighlight(voices, { engine: "macos", id: "Moira" }, catalog.recommended)).toBe(3);
	});

	test("on the recommended voice when none is set yet", () => {
		const voices = visibleVoices(buildRows(catalog, ""));
		expect(initialHighlight(voices, null, catalog.recommended)).toBe(0);
	});

	test("on the first voice when neither is present", () => {
		const voices = visibleVoices(buildRows(catalog, ""));
		expect(
			initialHighlight(
				voices,
				{ engine: "kitten", id: "Gone" },
				{ engine: "kitten", id: "Also gone" },
			),
		).toBe(0);
	});

	test("sameVoice needs both halves to match", () => {
		expect(sameVoice({ engine: "kitten", id: "Luna" }, { engine: "kitten", id: "Luna" })).toBe(
			true,
		);
		expect(sameVoice({ engine: "macos", id: "Luna" }, { engine: "kitten", id: "Luna" })).toBe(
			false,
		);
		expect(sameVoice(null, { engine: "kitten", id: "Luna" })).toBe(false);
	});
});

describe("reducePicker", () => {
	const start = initialState(catalog, null);

	test("up and down stop at the ends instead of wrapping", () => {
		expect(reducePicker(start, { type: "up" }, catalog).highlight).toBe(0);
		let s = start;
		for (let i = 0; i < 10; i++) s = reducePicker(s, { type: "down" }, catalog);
		expect(s.highlight).toBe(4);
	});

	test("tab jumps to the next group and wraps round", () => {
		let s = reducePicker(start, { type: "nextGroup" }, catalog);
		expect(visibleVoices(buildRows(catalog, ""))[s.highlight].name).toBe("Daniel");
		s = reducePicker(s, { type: "nextGroup" }, catalog);
		expect(visibleVoices(buildRows(catalog, ""))[s.highlight].name).toBe("Bells");
		s = reducePicker(s, { type: "nextGroup" }, catalog);
		expect(visibleVoices(buildRows(catalog, ""))[s.highlight].name).toBe("Jasper");
	});

	test("shift+tab goes back the other way", () => {
		const s = reducePicker(start, { type: "prevGroup" }, catalog);
		expect(visibleVoices(buildRows(catalog, ""))[s.highlight].name).toBe("Bells");
	});

	test("typing a filter keeps you on the same voice when it survives", () => {
		let s = { ...start, highlight: 3 }; // Moira
		s = reducePicker(s, { type: "filterChar", char: "m" }, catalog);
		const voices = visibleVoices(buildRows(catalog, s.filter));
		expect(voices[s.highlight].name).toBe("Moira");
	});

	test("typing a filter that hides your voice falls back to the first match", () => {
		let s = { ...start, highlight: 3 }; // Moira
		s = reducePicker(s, { type: "filterChar", char: "j" }, catalog);
		expect(s.filter).toBe("j");
		expect(visibleVoices(buildRows(catalog, s.filter))[s.highlight].name).toBe("Jasper");
	});

	test("backspace on an empty filter leaves filter mode rather than doing nothing", () => {
		const s = reducePicker({ ...start, filtering: true }, { type: "filterBackspace" }, catalog);
		expect(s.filtering).toBe(false);
		expect(s.filter).toBe("");
	});

	test("clearing the filter shows everything again", () => {
		let s = reducePicker({ ...start, filtering: true }, { type: "filterChar", char: "j" }, catalog);
		s = reducePicker(s, { type: "clearFilter" }, catalog);
		expect(s.filter).toBe("");
		expect(s.filtering).toBe(false);
		expect(visibleVoices(buildRows(catalog, s.filter)).length).toBe(5);
	});

	test("help toggles and typing a filter closes it", () => {
		const helped = reducePicker(start, { type: "toggleHelp" }, catalog);
		expect(helped.showHelp).toBe(true);
		expect(reducePicker(helped, { type: "startFilter" }, catalog).showHelp).toBe(false);
	});
});

describe("computeRowWindow", () => {
	const rows = buildRows(catalog, "");

	test("shows everything when it all fits", () => {
		expect(computeRowWindow(rows, 0, rows.length + 5)).toEqual({ start: 0, end: rows.length });
	});

	test("keeps the group heading in view with the first voice under it", () => {
		const target = rowIndexOf(rows, 2); // Daniel, first macOS voice
		const win = computeRowWindow(rows, target, 3);
		// The voice is visible, and so is the heading that names its group.
		expect(target).toBeGreaterThanOrEqual(win.start);
		expect(target).toBeLessThan(win.end);
		const heading = rows.slice(win.start, win.end).find((r) => r.kind === "heading");
		expect(heading && heading.kind === "heading" ? heading.group : null).toBe("macos");
	});

	test("never runs past either end", () => {
		const last = rows.length - 1;
		const win = computeRowWindow(rows, last, 3);
		expect(win.end).toBe(rows.length);
		expect(win.start).toBeGreaterThanOrEqual(0);
		expect(computeRowWindow(rows, -5, 3).start).toBe(0);
	});
});
