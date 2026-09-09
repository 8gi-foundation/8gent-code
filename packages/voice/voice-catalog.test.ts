/**
 * The catalog is what the picker offers, so it must describe THIS machine:
 * the macOS list is parsed from real `say -v '?'` output (fixture below,
 * captured on a stock install), never hardcoded, and an engine that is not
 * installed is reported as unavailable rather than silently offered.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	GROUP_LABELS,
	PREVIEW_SENTENCE,
	buildVoiceCatalog,
	isNoveltyVoice,
	parseSayVoices,
} from "./voice-catalog.js";

const FIXTURE = readFileSync(join(import.meta.dir, "test", "say-voices.txt"), "utf-8");

const allAvailable = async () => ({ available: true, reason: null });
const fixtureSay = async () => FIXTURE;

describe("parseSayVoices", () => {
	const voices = parseSayVoices(FIXTURE);

	test("reads every line of real say output", () => {
		// The fixture is verbatim `say -v '?'`; every line is one voice.
		const lines = FIXTURE.split("\n").filter((l) => l.trim().length > 0);
		expect(voices.length).toBe(lines.length);
	});

	test("keeps the id the engine needs and the language it speaks", () => {
		const albert = voices.find((v) => v.name === "Albert");
		expect(albert).toBeDefined();
		expect(albert?.engine).toBe("macos");
		expect(albert?.id).toBe("Albert");
		expect(albert?.language).toBe("en_US");
		expect(albert?.novelty).toBe(false);
	});

	test("turns the language code into something a person reads", () => {
		const alice = voices.find((v) => v.name === "Alice");
		expect(alice?.language).toBe("it_IT");
		// Intl names the language and region; a runtime without it keeps the code.
		expect(alice?.hint === "Italian (Italy)" || alice?.hint === "it_IT").toBe(true);
	});

	test("a name with a locale suffix keeps the full id but shows the short name", () => {
		const suffixed = voices.find((v) => v.id.includes(" ("));
		if (!suffixed) return; // stock installs may carry none
		expect(suffixed.name).not.toContain("(");
		expect(suffixed.id).toContain("(");
		expect(suffixed.hint.length).toBeGreaterThan(0);
	});

	test("flags the joke voices and leaves the real ones alone", () => {
		const novelty = voices.filter((v) => v.novelty).map((v) => v.name);
		expect(novelty).toContain("Bells");
		expect(novelty).toContain("Bubbles");
		expect(novelty).not.toContain("Daniel");
		expect(novelty).not.toContain("Samantha");
		expect(isNoveltyVoice("Zarvox")).toBe(true);
		expect(isNoveltyVoice("Moira")).toBe(false);
	});

	test("ignores anything that is not a voice line", () => {
		expect(parseSayVoices("")).toEqual([]);
		expect(parseSayVoices("not a voice line\n\n")).toEqual([]);
	});
});

describe("buildVoiceCatalog", () => {
	test("groups the engines this machine has, joke voices last", async () => {
		const cat = await buildVoiceCatalog({ probe: allAvailable, sayOutput: fixtureSay });
		const ids = cat.groups.map((g) => g.id);
		expect(ids).toEqual(["kitten", "supertonic", "macos", "fun"]);
		expect(cat.groups[0].label).toBe(GROUP_LABELS.kitten);
		expect(cat.unavailable).toEqual([]);
		// Every group the picker shows has something in it.
		for (const g of cat.groups) expect(g.voices.length).toBeGreaterThan(0);
	});

	test("the real macOS voices and the joke ones go to different groups", async () => {
		const cat = await buildVoiceCatalog({ probe: allAvailable, sayOutput: fixtureSay });
		const macos = cat.groups.find((g) => g.id === "macos");
		const fun = cat.groups.find((g) => g.id === "fun");
		expect(macos?.voices.every((v) => !v.novelty)).toBe(true);
		expect(fun?.voices.every((v) => v.novelty)).toBe(true);
		expect(fun?.voices.map((v) => v.name)).toContain("Bells");
	});

	test("recommends the first available engine's documented default", async () => {
		const cat = await buildVoiceCatalog({ probe: allAvailable, sayOutput: fixtureSay });
		expect(cat.recommended).toEqual({ engine: "kitten", id: "Bruno" });
	});

	test("an engine that is not installed is named with a reason, not offered", async () => {
		const cat = await buildVoiceCatalog({
			probe: async (engine) =>
				engine === "kitten"
					? { available: false, reason: "KittenTTS not installed" }
					: { available: true, reason: null },
			sayOutput: fixtureSay,
		});
		expect(cat.groups.map((g) => g.id)).not.toContain("kitten");
		expect(cat.unavailable).toContainEqual({
			engine: "kitten",
			reason: "KittenTTS not installed",
		});
		// The recommendation moves to the next engine that works.
		expect(cat.recommended).toEqual({ engine: "supertonic", id: "M1" });
	});

	test("say listing nothing is an unavailable engine, not an empty group", async () => {
		const cat = await buildVoiceCatalog({ probe: allAvailable, sayOutput: async () => "" });
		expect(cat.groups.map((g) => g.id)).not.toContain("macos");
		expect(cat.groups.map((g) => g.id)).not.toContain("fun");
		expect(cat.unavailable.some((u) => u.engine === "macos")).toBe(true);
	});

	test("no engine at all leaves nothing to recommend", async () => {
		const cat = await buildVoiceCatalog({
			probe: async () => ({ available: false, reason: "not installed" }),
			sayOutput: fixtureSay,
		});
		expect(cat.groups).toEqual([]);
		expect(cat.recommended).toBeNull();
		expect(cat.unavailable.length).toBe(3);
	});
});

test("the preview says who is speaking", () => {
	expect(PREVIEW_SENTENCE).toContain("8gent");
});
