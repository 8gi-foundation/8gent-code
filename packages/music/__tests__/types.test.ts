/**
 * GENRES table guardrail (#2934, part of #2922).
 *
 * The producer, the Replicate prompt builder and the TUI all key off this
 * table. A genre with an inverted BPM range or an unknown layer role would
 * produce silence or crash the synth, so the table itself is under test.
 */

import { describe, expect, test } from "bun:test";
import * as music from "../index.js";
import { GENRES, type LayerRole } from "../types.js";

const VALID_ROLES: LayerRole[] = ["drums", "bass", "melody", "pad", "fx", "vocal", "full"];

describe("GENRES table", () => {
	test("lists the fifteen genres the DJ surfaces advertise", () => {
		expect(Object.keys(GENRES).sort()).toEqual(
			[
				"ambient",
				"breakbeat",
				"downtempo",
				"drum-and-bass",
				"dub",
				"electro",
				"garage",
				"house",
				"idm",
				"jungle",
				"lofi",
				"minimal",
				"synthwave",
				"techno",
				"trance",
			].sort(),
		);
	});

	test("every genre has an ascending, positive BPM range", () => {
		for (const [genre, info] of Object.entries(GENRES)) {
			const [lo, hi] = info.bpmRange;
			expect(lo, `${genre} low bpm`).toBeGreaterThan(0);
			expect(hi, `${genre} high bpm`).toBeGreaterThan(lo);
			expect(hi, `${genre} high bpm sanity`).toBeLessThanOrEqual(200);
		}
	});

	test("every genre names a mood and at least one known layer role", () => {
		for (const [genre, info] of Object.entries(GENRES)) {
			expect(info.mood.length, `${genre} mood`).toBeGreaterThan(0);
			expect(info.layers.length, `${genre} layers`).toBeGreaterThan(0);
			for (const role of info.layers) {
				expect(VALID_ROLES, `${genre} role ${role}`).toContain(role);
			}
			expect(new Set(info.layers).size, `${genre} duplicate layers`).toBe(info.layers.length);
		}
	});

	test("fast genres carry drums, ambient does not", () => {
		expect(GENRES["drum-and-bass"].bpmRange[0]).toBeGreaterThanOrEqual(160);
		expect(GENRES.jungle.layers).toContain("drums");
		expect(GENRES.ambient.layers).not.toContain("drums");
		expect(GENRES.ambient.bpmRange[1]).toBeLessThanOrEqual(90);
	});
});

describe("package entry point", () => {
	test("exports every backend the TUI lazy-imports", () => {
		expect(typeof music.DJ).toBe("function");
		expect(typeof music.MusicProducer).toBe("function");
		expect(typeof music.Mixer).toBe("function");
		expect(typeof music.Player).toBe("function");
		expect(typeof music.SoxSynth).toBe("function");
		expect(typeof music.ReplicateBackend).toBe("function");
		expect(music.GENRES).toBe(GENRES);
	});
});
