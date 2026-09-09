/**
 * SoxSynth guardrail (#2934, part of #2922).
 *
 * SoxSynth is the deterministic instrument layer: beat and bar maths, drum
 * patterns, scale frequencies. Every sox invocation goes to the fake
 * toolchain, so these tests assert the commands the synth builds (hit
 * placement in seconds, note frequencies in Hz, effect parameters) without
 * rendering a single sample.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { SoxSynth } from "../sox-synth.js";
import {
	type FakeTools,
	type RecordedCall,
	argsAfter,
	installFakeTools,
	numberAfter,
} from "./fake-tools.js";

let tools: FakeTools;
let synth: SoxSynth;

beforeAll(() => {
	tools = installFakeTools("8gent-sox-synth-");
	synth = new SoxSynth(`${tools.scratch}/layers`);
});

afterAll(() => tools.restore());

beforeEach(() => tools.reset());

/** mixAt logs `sox <sample> <sample>.padded.wav pad <offset> 0`; group offsets by sample name. */
function hitOffsets(calls: RecordedCall[]): Record<string, number[]> {
	const out: Record<string, number[]> = {};
	for (const c of calls) {
		if (c.tool !== "sox" || c.args[2] !== "pad") continue;
		const hit = basename(c.args[0]);
		(out[hit] ??= []).push(Number.parseFloat(c.args[3]));
	}
	return out;
}

/** Calls of the form `sox -n -r 44100 <out> synth ...` (a synthesised hit or note). */
function synthCalls(calls: RecordedCall[]): RecordedCall[] {
	return calls.filter((c) => c.tool === "sox" && c.args[0] === "-n" && c.args.includes("synth"));
}

function midiHz(midi: number): number {
	return 440 * 2 ** ((midi - 69) / 12);
}

describe("SoxSynth.generateDrums", () => {
	test("four-four at 120 BPM places kicks on every beat, snares on 2 and 4, hats on every eighth", () => {
		const out = synth.generateDrums(120, 1, "four-four");
		expect(out.startsWith(`${tools.scratch}/layers/drums-`)).toBe(true);
		expect(existsSync(out)).toBe(true);

		const calls = tools.calls();
		// Silence base is exactly one bar long: 4 beats at 0.5s.
		const base = calls.find((c) => c.tool === "sox" && c.args.includes("trim"));
		expect(base?.args).toEqual(["-n", "-r", "44100", "-c", "1", out, "trim", "0", "2"]);

		const hits = hitOffsets(calls);
		expect(hits["_kick.wav"]).toEqual([0, 0.5, 1, 1.5]);
		expect(hits["_snare.wav"]).toEqual([0.5, 1.5]);
		expect(hits["_hihat.wav"]).toEqual([0, 0.25, 0.75, 1, 1.25, 1.75]);
		expect(hits["_openhat.wav"]).toEqual([0.5, 1.5]);
	});

	test("bars scale the base length and repeat the pattern per bar", () => {
		const out = synth.generateDrums(120, 3, "four-four");
		const base = tools.calls().find((c) => c.tool === "sox" && c.args.includes("trim"));
		expect(base?.args.slice(-4)).toEqual([out, "trim", "0", "6"]);
		const hits = hitOffsets(tools.calls());
		expect(hits["_kick.wav"]).toHaveLength(12);
		expect(hits["_kick.wav"]?.slice(4, 8)).toEqual([2, 2.5, 3, 3.5]);
		expect(hits["_snare.wav"]).toHaveLength(6);
	});

	test("breakbeat kicks on 1 and the and-of-2, no open hats", () => {
		synth.generateDrums(120, 1, "breakbeat");
		const hits = hitOffsets(tools.calls());
		expect(hits["_kick.wav"]).toEqual([0, 0.75]);
		expect(hits["_snare.wav"]).toEqual([0.5, 1.5]);
		expect(hits["_hihat.wav"]).toHaveLength(8);
		expect(hits["_openhat.wav"]).toBeUndefined();
	});

	test("dnb at 160 BPM kicks on 1 and 2.75, hats on even sixteenths", () => {
		synth.generateDrums(160, 1, "dnb");
		const beat = 60 / 160;
		const hits = hitOffsets(tools.calls());
		expect(hits["_kick.wav"]).toEqual([0, Number((2.75 * beat).toFixed(4))]);
		expect(hits["_snare.wav"]).toEqual([Number(beat.toFixed(4)), Number((3 * beat).toFixed(4))]);
		expect(hits["_hihat.wav"]).toHaveLength(8);
		expect(hits["_hihat.wav"]?.[1]).toBeCloseTo(2 * (beat / 4), 4);
	});

	test("synthesises the four drum hits with their sweep, noise and fade parameters", () => {
		synth.generateDrums(120, 1, "four-four");
		const synths = synthCalls(tools.calls());
		const byName = Object.fromEntries(synths.map((c) => [basename(c.args[3]), argsAfter(c, 4)]));
		expect(byName["_kick.wav"]).toBe("synth 0.3 sine 150:40 vol 0.9 fade l 0.005 0.3 0.1");
		expect(byName["_hihat.wav"]).toBe(
			"synth 0.05 noise vol 0.25 highpass 8000 fade l 0.001 0.05 0.03",
		);
		expect(byName["_openhat.wav"]).toBe(
			"synth 0.2 noise vol 0.2 highpass 6000 fade l 0.001 0.2 0.15",
		);
		// Snare is a noise burst mixed with a pitched body.
		expect(byName["_snare.wav.noise.wav"]).toBe("synth 0.15 noise vol 0.4 fade l 0.001 0.15 0.1");
		expect(byName["_snare.wav.body.wav"]).toBe(
			"synth 0.15 sine 200:120 vol 0.5 fade l 0.001 0.15 0.08",
		);
		// Temporary hit files are removed after placement.
		expect(existsSync(`${tools.scratch}/layers/_kick.wav`)).toBe(false);
	});
});

describe("SoxSynth.generateBass", () => {
	test("A minor at 120 BPM plays the root on 1 and the fifth on 3, in octave 1", () => {
		const out = synth.generateBass(120, 2, "Am");
		expect(existsSync(out)).toBe(true);
		const calls = tools.calls();

		const base = calls.find((c) => c.tool === "sox" && c.args.includes("trim"));
		expect(base?.args.at(-1)).toBe("4");

		const notes = synthCalls(calls);
		expect(notes).toHaveLength(4);
		const freqs = notes.map((c) => numberAfter(c, "sine"));
		expect(freqs[0]).toBeCloseTo(midiHz(33), 6); // A1 = 55 Hz
		expect(freqs[1]).toBeCloseTo(midiHz(40), 6); // E2
		expect(argsAfter(notes[0], 4)).toBe(
			`synth 0.75 sine ${notes[0].args[7]} vol 0.6 fade l 0.01 0.75 0.05 lowpass 200`,
		);

		const hits = hitOffsets(calls);
		expect(hits["_bass_n1.wav"]).toEqual([0, 2]);
		expect(hits["_bass_n2.wav"]).toEqual([1, 3]);
	});

	test("major keys use the major fifth and the given root", () => {
		synth.generateBass(120, 1, "C");
		const freqs = synthCalls(tools.calls()).map((c) => numberAfter(c, "sine"));
		expect(freqs[0]).toBeCloseTo(midiHz(24), 6); // C1
		expect(freqs[1]).toBeCloseTo(midiHz(31), 6); // G1
	});

	test("an unknown key falls back to A minor instead of throwing", () => {
		synth.generateBass(120, 1, "H#m");
		const freqs = synthCalls(tools.calls()).map((c) => numberAfter(c, "sine"));
		expect(freqs[0]).toBeCloseTo(55, 6);
	});
});

describe("SoxSynth.generatePad", () => {
	test("builds a root, third, fifth chord in octave 3 and runs it through reverb", () => {
		const out = synth.generatePad(120, 2, "Am");
		expect(existsSync(out)).toBe(true);
		const calls = tools.calls();

		const parts = synthCalls(calls);
		expect(parts).toHaveLength(3);
		const freqs = parts.map((c) => numberAfter(c, "sine"));
		expect(freqs[0]).toBeCloseTo(midiHz(57), 6); // A3
		expect(freqs[1]).toBeCloseTo(midiHz(60), 6); // C4 (minor third)
		expect(freqs[2]).toBeCloseTo(midiHz(64), 6); // E4
		// Each voice gets a third of the pad level and a slow fade over two bars (4s).
		expect(parts[0].args.slice(4, 6)).toEqual(["synth", "4"]);
		expect(numberAfter(parts[0], "vol")).toBeCloseTo(0.15 / 3, 12);
		expect(argsAfter(parts[0], 10)).toBe("fade l 0.5 4 1.0");

		const mix = calls.find((c) => c.tool === "sox" && c.args[0] === "-m");
		expect(mix?.args).toHaveLength(5);
		expect(mix?.args.at(-1)).toBe(out);

		const reverb = calls.find((c) => c.tool === "sox" && c.args.includes("reverb"));
		expect(reverb?.args).toEqual([
			out,
			`${out}.reverb.wav`,
			"reverb",
			"80",
			"50",
			"100",
			"vol",
			"0.6",
		]);
	});

	test("major keys use the major third", () => {
		synth.generatePad(120, 1, "C");
		const freqs = synthCalls(tools.calls()).map((c) => numberAfter(c, "sine"));
		expect(freqs[1]).toBeCloseTo(midiHz(52), 6); // E3
	});
});

describe("SoxSynth.generateMelody", () => {
	test("walks the melodic contour in octave 4 on beats 1, 2.5 and 3.5", () => {
		const out = synth.generateMelody(120, 2, "Am");
		expect(existsSync(out)).toBe(true);
		const calls = tools.calls();

		const notes = synthCalls(calls);
		expect(notes).toHaveLength(6);
		const freqs = notes.map((c) => numberAfter(c, "square"));
		// Bar 0: degrees 0, 2, 4 of A minor -> A4, C5, E5
		expect(freqs[0]).toBeCloseTo(440, 6);
		expect(freqs[1]).toBeCloseTo(midiHz(72), 6);
		expect(freqs[2]).toBeCloseTo(midiHz(76), 6);
		// Bar 1: degrees 2, 4, 5 -> C5, E5, F5
		expect(freqs[3]).toBeCloseTo(midiHz(72), 6);
		expect(freqs[4]).toBeCloseTo(midiHz(76), 6);
		expect(freqs[5]).toBeCloseTo(midiHz(77), 6);
		expect(argsAfter(notes[0], 4)).toBe(
			"synth 0.4 square 440 vol 0.2 fade l 0.01 0.4 0.05 lowpass 3000",
		);

		const hits = hitOffsets(calls);
		expect(hits["_mel_0.wav"]).toEqual([0, 2]);
		expect(hits["_mel_1.wav"]).toEqual([0.75, 2.75]);
		expect(hits["_mel_2.wav"]).toEqual([1.25, 3.25]);
	});

	test("adds a tempo-synced echo (dotted eighth at the current BPM)", () => {
		const out = synth.generateMelody(120, 1, "Am");
		const echo = tools.calls().find((c) => c.tool === "sox" && c.args.includes("echo"));
		// 375 ms per beat-multiplier at 120 BPM: round(0.5 * 375) = 188 ms
		expect(echo?.args).toEqual([out, `${out}.delay.wav`, "echo", "0.6", "0.6", "188", "0.3"]);
	});

	test("echo time follows the tempo", () => {
		synth.generateMelody(90, 1, "Am");
		const echo = tools.calls().find((c) => c.tool === "sox" && c.args.includes("echo"));
		expect(echo?.args[5]).toBe(String(Math.round((60 / 90) * 375)));
	});
});
