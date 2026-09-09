/**
 * MusicProducer guardrail (#2934, part of #2922).
 *
 * The producer turns a partial MixConfig into a Track: fills in BPM from the
 * genre table, works out bars, picks a drum pattern, assigns per-role levels
 * and pans, then mixes, masters, loops and extends. All rendering goes to the
 * fake toolchain; the assertions are on the Track spec and the pipeline
 * decisions visible in the argv log.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { basename } from "node:path";
import { MusicProducer } from "../producer.js";
import { GENRES } from "../types.js";
import { type FakeTools, installFakeTools } from "./fake-tools.js";

let tools: FakeTools;
let producer: MusicProducer;
let outDir: string;
const realKey = process.env.REPLICATE_API_KEY;

beforeAll(() => {
	// No API key: the producer must take the deterministic sox path.
	delete process.env.REPLICATE_API_KEY;
	tools = installFakeTools("8gent-producer-");
	outDir = `${tools.scratch}/studio`;
	producer = new MusicProducer(outDir);
});

afterAll(() => {
	producer.stop();
	tools.restore();
	if (realKey === undefined) delete process.env.REPLICATE_API_KEY;
	else process.env.REPLICATE_API_KEY = realKey;
});

beforeEach(() => {
	tools.reset();
	tools.setEnv("FAKE_SOXI_DURATION", "8");
});

function kickOffsets(): number[] {
	return tools
		.callsFor("sox")
		.filter((c) => basename(c.args[0]) === "_kick.wav" && c.args[2] === "pad")
		.map((c) => Number.parseFloat(c.args[3]));
}

describe("MusicProducer.produce", () => {
	test("builds a techno track spec with the genre's layers, levels and pans", async () => {
		const track = await producer.produce({
			genre: "techno",
			bpm: 128,
			key: "Am",
			durationSec: 8,
			loop: false,
		});

		expect(track.genre).toBe("techno");
		expect(track.bpm).toBe(128);
		expect(track.durationSec).toBe(8);
		expect(track.id).toMatch(/^track_\d+_[a-z0-9]{1,4}$/);
		expect(track.createdAt).toBeGreaterThan(0);
		expect(track.layers.map((l) => [l.name, l.role, l.volume, l.pan])).toEqual([
			["drums", "drums", 0.8, 0],
			["bass", "bass", 0.7, 0],
			["pad", "pad", 0.4, -0.1],
			["fx", "fx", 0.2, 0.5],
		]);
		for (const l of track.layers) expect(l.path.startsWith(`${outDir}/layers/`)).toBe(true);

		// No loop requested and the render already covers the duration: mastered only.
		expect(track.path.startsWith(`${outDir}/tracks/techno-128bpm-`)).toBe(true);
		expect(track.path.endsWith("-mastered.wav")).toBe(true);

		// 8s at 128 BPM is 4.27 bars, rounded to 4: the drum base is 4 bars of 1.875s.
		const base = tools
			.callsFor("sox")
			.find((c) => c.args.includes("trim") && basename(c.args[5] ?? "").startsWith("drums-"));
		expect(base?.args.slice(-2)).toEqual(["0", "7.5"]);
		// Four-on-the-floor: 4 kicks per bar over 4 bars.
		expect(kickOffsets()).toHaveLength(16);
	});

	test("picks a BPM inside the genre range and the genre's mood when not given", async () => {
		const track = await producer.produce({ genre: "lofi", durationSec: 4, loop: false });
		const [lo, hi] = GENRES.lofi.bpmRange;
		expect(track.bpm).toBeGreaterThanOrEqual(lo);
		expect(track.bpm).toBeLessThanOrEqual(hi);
		expect(track.layers.map((l) => l.role)).toEqual(GENRES.lofi.layers);
	});

	test("defaults to house at 60 seconds", async () => {
		tools.setEnv("FAKE_SOXI_DURATION", "60");
		const track = await producer.produce({ bpm: 120, layers: ["bass"], loop: false });
		expect(track.genre).toBe("house");
		expect(track.durationSec).toBe(60);
	}, 15000);

	test("jungle and drum-and-bass use the dnb drum pattern", async () => {
		const track = await producer.produce({
			genre: "jungle",
			bpm: 160,
			durationSec: 3,
			loop: false,
		});
		const beat = 60 / 160;
		// dnb: kicks on 1 and 2.75 of every bar.
		expect(kickOffsets().slice(0, 2)).toEqual([0, Number((2.75 * beat).toFixed(4))]);
		expect(track.layers.map((l) => l.role)).toEqual(GENRES.jungle.layers);
	});

	test("breakbeat uses the breakbeat pattern", async () => {
		await producer.produce({ genre: "breakbeat", bpm: 120, durationSec: 2, loop: false });
		expect(kickOffsets().slice(0, 2)).toEqual([0, 0.75]);
	});

	test("loop is on by default and the track is made seamless", async () => {
		const track = await producer.produce({ genre: "minimal", bpm: 120, durationSec: 8 });
		expect(track.path.endsWith("-mastered-loop.wav")).toBe(true);
		// The crossfade call is `sox <tail> <xfade> fade l 0 2 2` (hits also fade, but as an effect after synth).
		const fade = tools.callsFor("sox").find((c) => c.args[2] === "fade");
		expect(fade?.args.slice(-5)).toEqual(["fade", "l", "0", "2", "2"]);
	});

	test("extends a short render to reach the requested duration", async () => {
		tools.setEnv("FAKE_SOXI_DURATION", "2");
		const track = await producer.produce({ genre: "minimal", bpm: 120, durationSec: 8 });
		// 2s rendered for 8s requested: ceil(8 / 2) = 4 repeats.
		expect(track.path.endsWith("-loop-x4.wav")).toBe(true);
		const extend = tools.callsFor("sox").find((c) => c.args.at(-1)?.endsWith("-x4.wav"));
		expect(extend?.args).toHaveLength(5);
	});

	test("honours an explicit layer list and key", async () => {
		const track = await producer.produce({
			genre: "house",
			bpm: 120,
			key: "C",
			durationSec: 4,
			layers: ["bass"],
			loop: false,
		});
		expect(track.layers.map((l) => l.role)).toEqual(["bass"]);
		const note = tools.callsFor("sox").find((c) => c.args.includes("sine"));
		// C1 is 32.70 Hz.
		expect(Number.parseFloat(note?.args[7] ?? "0")).toBeCloseTo(32.703, 2);
	});
});

describe("MusicProducer sets and playback", () => {
	test("djSet produces one non-looping track per genre at the requested length", async () => {
		const tracks = await producer.djSet(["ambient", "dub"], 0.05);
		expect(tracks.map((t) => t.genre)).toEqual(["ambient", "dub"]);
		for (const t of tracks) {
			expect(t.durationSec).toBe(3);
			expect(t.path.includes("-loop")).toBe(false);
		}
	});

	test("playDjSet queues every track through the player", async () => {
		const tracks = await producer.djSet(["ambient"], 0.05);
		await producer.playDjSet(tracks);
		await new Promise((r) => setTimeout(r, 150));
		expect(tools.callsFor("afplay").map((c) => c.args[0])).toEqual([tracks[0].path]);
		expect(producer.status.queueLength).toBe(0);
	});

	test("play, loop and stop drive the player status", async () => {
		const track = await producer.produce({
			genre: "ambient",
			bpm: 70,
			durationSec: 3,
			loop: false,
		});
		producer.play(track);
		expect(producer.status.playing).toBe(true);
		expect(producer.status.track).toBe(track.path);
		producer.loop(track);
		expect(producer.status.looping).toBe(true);
		producer.stop();
		expect(producer.status.playing).toBe(false);
	});

	test("toMp3 encodes the track file", async () => {
		const track = await producer.produce({
			genre: "ambient",
			bpm: 70,
			durationSec: 3,
			loop: false,
		});
		const mp3 = producer.toMp3(track);
		expect(mp3).toBe(track.path.replace(".wav", ".mp3"));
		expect(tools.callsFor("ffmpeg")[0].args).toContain("libmp3lame");
	});
});
