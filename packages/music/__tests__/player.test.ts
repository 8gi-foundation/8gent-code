/**
 * Player guardrail (#2934, part of #2922).
 *
 * Player wraps afplay and osascript. Both resolve to fake executables here,
 * so the suite covers queue management, status transitions and the volume
 * command without producing sound or touching the system mixer.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Player } from "../player.js";
import { type FakeTools, installFakeTools } from "./fake-tools.js";

let tools: FakeTools;

beforeAll(() => {
	tools = installFakeTools("8gent-player-");
});

afterAll(() => tools.restore());

beforeEach(() => tools.reset());

// The fake afplay exits instantly and appends to the log asynchronously. A fixed
// sleep raced under a heavier test run (one test saw nothing, the next saw the
// previous test's call), so wait for the log to hold the calls we expect.
const waitForCalls = async (tool: "afplay" | "osascript", count: number, timeoutMs = 3000) => {
	const start = Date.now();
	while (tools.callsFor(tool).length < count) {
		if (Date.now() - start > timeoutMs) break;
		await new Promise((r) => setTimeout(r, 20));
	}
};

describe("Player status and playback", () => {
	test("starts idle", () => {
		const player = new Player();
		expect(player.status).toEqual({
			playing: false,
			track: null,
			looping: false,
			queueLength: 0,
		});
	});

	test("refuses to play a missing file and stays idle", async () => {
		const player = new Player();
		player.play(`${tools.scratch}/does-not-exist.wav`);
		expect(player.status.playing).toBe(false);
		expect(player.status.track).toBeNull();
		await waitForCalls("afplay", 1);
		expect(tools.callsFor("afplay")).toEqual([]);
	});

	test("play starts afplay on the file and stop clears the track", async () => {
		const player = new Player();
		const track = tools.file("one.wav", "riff");
		player.play(track);
		expect(player.status.playing).toBe(true);
		expect(player.status.track).toBe(track);
		expect(player.status.looping).toBe(false);
		await waitForCalls("afplay", 1);
		expect(tools.callsFor("afplay").map((c) => c.args)).toEqual([[track]]);
		player.stop();
		expect(player.status).toEqual({
			playing: false,
			track: null,
			looping: false,
			queueLength: 0,
		});
	});

	test("playLoop marks the player as looping until stopped", () => {
		const player = new Player();
		const track = tools.file("loop.wav", "riff");
		player.playLoop(track);
		expect(player.status.looping).toBe(true);
		expect(player.status.playing).toBe(true);
		player.stop();
		expect(player.status.looping).toBe(false);
	});

	test("play replaces the current track", () => {
		const player = new Player();
		const a = tools.file("a.wav", "riff");
		const b = tools.file("b.wav", "riff");
		player.play(a);
		player.play(b);
		expect(player.status.track).toBe(b);
		player.stop();
	});
});

describe("Player queue", () => {
	test("enqueue keeps only files that exist", () => {
		const player = new Player();
		const real = tools.file("q1.wav", "riff");
		player.enqueue(real, `${tools.scratch}/ghost.wav`, real);
		expect(player.status.queueLength).toBe(2);
	});

	test("playQueue plays every queued file in order and drains the queue", async () => {
		const player = new Player();
		const first = tools.file("first.wav", "riff");
		const second = tools.file("second.wav", "riff");
		player.enqueue(first, second);
		await player.playQueue();
		expect(player.status.queueLength).toBe(0);
		await waitForCalls("afplay", 2);
		expect(tools.callsFor("afplay").map((c) => c.args[0])).toEqual([first, second]);
	});
});

describe("Player.setVolume", () => {
	test("sends the percentage to the system mixer, clamped to 0..100", () => {
		const player = new Player();
		player.setVolume(65);
		player.setVolume(150);
		player.setVolume(-20);
		const sent = tools.callsFor("osascript").map((c) => c.args);
		expect(sent).toEqual([
			["-e", "set volume output volume 65"],
			["-e", "set volume output volume 100"],
			["-e", "set volume output volume 0"],
		]);
	});
});
