/**
 * Mixer guardrail (#2934, part of #2922).
 *
 * The mixer is a thin command builder over sox and ffmpeg: role-based EQ
 * chains, the master chain, the seamless-loop crossfade maths and the MP3
 * encode. All of it is asserted against the fake toolchain's argv log.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { Mixer } from "../mixer.js";
import type { Layer } from "../types.js";
import { type FakeTools, argsAfter, installFakeTools } from "./fake-tools.js";

let tools: FakeTools;
let mixer: Mixer;
let outDir: string;

beforeAll(() => {
	tools = installFakeTools("8gent-mixer-");
	outDir = `${tools.scratch}/tracks`;
	mixer = new Mixer(outDir);
});

afterAll(() => tools.restore());

beforeEach(() => {
	tools.reset();
	tools.setEnv("FAKE_SOX_EXIT", undefined);
	tools.setEnv("FAKE_FFMPEG_EXIT", undefined);
	tools.setEnv("FAKE_SOXI_DURATION", undefined);
});

function layer(name: string, role: Layer["role"], volume = 0.5): Layer {
	return { name, path: tools.file(`${name}.wav`, "riff"), role, volume, pan: 0 };
}

describe("Mixer.mixLayers", () => {
	test("no layers: returns the target path without running anything", () => {
		expect(mixer.mixLayers([], "empty")).toBe(`${outDir}/empty.wav`);
		expect(tools.calls()).toEqual([]);
	});

	test("one layer: copies it straight through", () => {
		const only = layer("solo", "full");
		const out = mixer.mixLayers([only], "solo-mix");
		expect(out).toBe(`${outDir}/solo-mix.wav`);
		expect(existsSync(out)).toBe(true);
		expect(tools.calls()).toEqual([]);
	});

	test("applies the role EQ chain per layer, then sums them", () => {
		const layers = [
			layer("kick", "drums", 0.8),
			layer("bass", "bass", 0.7),
			layer("lead", "melody", 0.5),
			layer("pad", "pad", 0.4),
			layer("sweep", "fx", 0.2),
			layer("voice", "vocal", 1),
		];
		const out = mixer.mixLayers(layers, "full");
		const sox = tools.callsFor("sox");
		expect(sox).toHaveLength(7);

		const chains = sox.slice(0, 6).map((c) => argsAfter(c, 2));
		expect(chains).toEqual([
			"vol 0.80 highpass 30 compand 0.01,0.1 -70,-60,-20 0 0 0.1",
			"vol 0.70 lowpass 250 highpass 30",
			"vol 0.50 highpass 300 lowpass 8000",
			"vol 0.40 highpass 200 lowpass 6000 reverb 60",
			"vol 0.20 highpass 500 reverb 80 50 100",
			"vol 1.00",
		]);
		for (let i = 0; i < 6; i++) {
			expect(sox[i].args[0]).toBe(layers[i].path);
			expect(sox[i].args[1]).toBe(`${outDir}/_mix_layer_${i}.wav`);
		}

		const sum = sox[6];
		expect(sum.args[0]).toBe("-m");
		expect(sum.args.slice(1, 7)).toEqual(
			Array.from({ length: 6 }, (_, i) => `${outDir}/_mix_layer_${i}.wav`),
		);
		expect(sum.args.at(-1)).toBe(out);
		// Intermediates are cleaned up.
		expect(existsSync(`${outDir}/_mix_layer_0.wav`)).toBe(false);
	});

	test("when every layer fails to process, returns the path without summing", () => {
		tools.setEnv("FAKE_SOX_EXIT", "1");
		const out = mixer.mixLayers([layer("a", "drums"), layer("b", "bass")], "broken");
		expect(out).toBe(`${outDir}/broken.wav`);
		expect(tools.callsFor("sox").some((c) => c.args[0] === "-m")).toBe(false);
	});
});

describe("Mixer.master", () => {
	test("runs the compressor and normaliser into a -mastered file", () => {
		const input = tools.file("raw.wav");
		const out = mixer.master(input);
		expect(out).toBe(input.replace(".wav", "-mastered.wav"));
		const [call] = tools.callsFor("sox");
		expect(call.args).toEqual([
			input,
			out,
			"compand",
			"0.01,0.3",
			"-70,-60,-20",
			"-5",
			"0",
			"0.1",
			"norm",
			"-1",
		]);
	});

	test("returns the unmastered input when sox fails", () => {
		tools.setEnv("FAKE_SOX_EXIT", "1");
		const input = tools.file("raw2.wav");
		expect(mixer.master(input)).toBe(input);
	});
});

describe("Mixer.makeLoop", () => {
	test("splits tail, head and body around the crossfade and re-joins them", () => {
		tools.setEnv("FAKE_SOXI_DURATION", "10");
		const input = tools.file("loopable.wav");
		const out = mixer.makeLoop(input, 2);
		expect(out).toBe(input.replace(".wav", "-loop.wav"));

		expect(tools.callsFor("soxi")[0].args).toEqual(["-D", input]);
		const sox = tools.callsFor("sox").map((c) => c.args);
		expect(sox).toEqual([
			[input, `${input}.tail.wav`, "trim", "8"],
			[input, `${input}.head.wav`, "trim", "0", "2"],
			[input, `${input}.body.wav`, "trim", "2", "6"],
			[`${input}.tail.wav`, `${input}.xfade.wav`, "fade", "l", "0", "2", "2"],
			[`${input}.body.wav`, `${input}.xfade.wav`, out],
		]);
		expect(existsSync(`${input}.tail.wav`)).toBe(false);
	});

	test("crossfade length drives every cut point", () => {
		tools.setEnv("FAKE_SOXI_DURATION", "30");
		const input = tools.file("long.wav");
		mixer.makeLoop(input, 5);
		const sox = tools.callsFor("sox").map((c) => c.args.slice(2));
		expect(sox[0]).toEqual(["trim", "25"]);
		expect(sox[1]).toEqual(["trim", "0", "5"]);
		expect(sox[2]).toEqual(["trim", "5", "20"]);
		expect(sox[3]).toEqual(["fade", "l", "0", "5", "5"]);
	});

	test("a track shorter than three crossfades is copied, not cut", () => {
		tools.setEnv("FAKE_SOXI_DURATION", "5");
		const input = tools.file("short.wav");
		const out = mixer.makeLoop(input, 2);
		expect(existsSync(out)).toBe(true);
		expect(tools.callsFor("sox")).toEqual([]);
	});
});

describe("Mixer.toMp3 and Mixer.extend", () => {
	test("encodes with libmp3lame at the requested bitrate", () => {
		const input = tools.file("encode.wav");
		const out = mixer.toMp3(input, 128);
		expect(out).toBe(input.replace(".wav", ".mp3"));
		const [call] = tools.callsFor("ffmpeg");
		expect(call.args).toEqual(["-y", "-i", input, "-codec:a", "libmp3lame", "-b:a", "128k", out]);
	});

	test("defaults to 192k and falls back to the wav when ffmpeg fails", () => {
		const input = tools.file("encode2.wav");
		mixer.toMp3(input);
		expect(tools.callsFor("ffmpeg")[0].args).toContain("192k");
		tools.setEnv("FAKE_FFMPEG_EXIT", "1");
		expect(mixer.toMp3(input)).toBe(input);
	});

	test("extend concatenates the input N times", () => {
		const input = tools.file("extend.wav");
		const out = mixer.extend(input, 3);
		expect(out).toBe(input.replace(".wav", "-x3.wav"));
		expect(tools.callsFor("sox")[0].args).toEqual([input, input, input, out]);
	});

	test("extend returns the input when sox fails", () => {
		tools.setEnv("FAKE_SOX_EXIT", "1");
		const input = tools.file("extend2.wav");
		expect(mixer.extend(input, 2)).toBe(input);
	});
});
