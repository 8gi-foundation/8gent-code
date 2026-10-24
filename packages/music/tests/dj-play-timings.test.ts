/**
 * Where the time goes in /dj play (#4907, "lil bit slow"): each stage is stamped and the
 * last play prints as one line in /dj doctor. A fake mpv answers on a timeline from the
 * moment it is spawned, so the stages have known lengths and no network or mic is used.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	DJ,
	type PlayTimings,
	formatPlayTimings,
	setAudioGraceMs,
	setDjSpawn,
	setDjTools,
	setMpvTransport,
	setVolumeStore,
} from "../dj";

describe("the timing line", () => {
	const t = (o: Partial<PlayTimings>): PlayTimings => ({
		searchMs: 2100,
		spawnAt: 1000,
		ipcAt: 1600,
		loadedAt: 5000,
		soundAt: 6200,
		...o,
	});
	test("search, mpv, resolve and first sound, in seconds", () => {
		expect(formatPlayTimings(t({}))).toBe(
			"Last play: search 2.1s, mpv 0.6s, resolve 3.4s, first sound 1.2s",
		);
	});
	test("a URL played directly has no search stage", () => {
		expect(formatPlayTimings(t({ searchMs: null }))).toBe(
			"Last play: mpv 0.6s, resolve 3.4s, first sound 1.2s",
		);
	});
	test("a stage not reached says pending", () => {
		expect(formatPlayTimings(t({ loadedAt: null, soundAt: null }))).toBe(
			"Last play: search 2.1s, mpv 0.6s, resolve pending, first sound pending",
		);
		expect(formatPlayTimings(t({ ipcAt: null, loadedAt: null, soundAt: null }))).toContain(
			"mpv pending",
		);
	});
	test("nothing played yet", () => {
		expect(formatPlayTimings(null)).toBe("Last play: none yet");
	});
});

// ---- a fake mpv on a timeline ----
let spawnedAt = 0;
const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
function timeline(answerAt: number, loadedAt: number, soundAt: number) {
	setMpvTransport(async (cmd) => {
		const { command } = JSON.parse(cmd) as { command: [string, string] };
		const dt = Date.now() - spawnedAt;
		if (spawnedAt === 0 || dt < answerAt || command[0] !== "get_property")
			return spawnedAt === 0 || dt < answerAt ? null : line({ error: "success" });
		const ok = (data: unknown) => line({ data, error: "success" });
		const unavailable = line({ error: "property unavailable" });
		switch (command[1]) {
			case "mpv-version":
				return ok("mpv 0.40.0");
			case "duration":
				return dt >= loadedAt ? ok(200) : unavailable;
			case "playback-time":
				return dt >= soundAt ? ok(1.5) : unavailable;
			case "idle-active":
				return ok(false);
			case "current-ao":
				return ok("opensles");
			case "volume":
				return ok(100);
			case "mute":
			case "pause":
				return ok(false);
			default:
				return unavailable;
		}
	});
}

const mpvArgs: string[][] = [];
function stubSpawn(cmd: string, args: string[]): ChildProcess {
	const c = new EventEmitter() as unknown as ChildProcess & { stdout: EventEmitter };
	(c as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
	(c as unknown as { kill: () => boolean }).kill = () => true;
	(c as unknown as { unref: () => void }).unref = () => {};
	if (cmd === "/stub/mpv") {
		spawnedAt = Date.now();
		mpvArgs.push(args);
	} else {
		// yt-dlp search: one row after 120 ms
		setTimeout(() => {
			(c as unknown as { stdout: EventEmitter }).stdout.emit(
				"data",
				"Last Last\thttps://www.youtube.com/watch?v=a\t170\n",
			);
			c.emit("close", 0);
		}, 120);
	}
	return c;
}

beforeEach(() => {
	spawnedAt = 0;
	mpvArgs.length = 0;
	setDjSpawn(stubSpawn);
	setDjTools({ mpv: "/stub/mpv", ytdlp: "/stub/yt-dlp" });
	setVolumeStore({ load: () => null, save: () => {} });
	setAudioGraceMs(0);
});
afterEach(() => {
	new DJ().stop();
	setMpvTransport();
	setDjSpawn();
	setDjTools();
	setVolumeStore();
	setAudioGraceMs();
});

async function until(check: () => boolean, ms: number): Promise<void> {
	const t0 = Date.now();
	while (!check() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
}

describe("/dj play, measured", () => {
	test("play returns when mpv answers, not after a fixed 1.5 s", async () => {
		timeline(200, 700, 1000);
		const dj = new DJ();
		const t0 = Date.now();
		await dj.play("burna boy");
		const took = Date.now() - t0;
		// 120 ms search + about 200 ms for mpv; the old fixed wait made this at least 1620 ms.
		expect(took).toBeLessThan(1000);
	});

	test("each stage is stamped from what mpv reports, and printed as one line", async () => {
		timeline(200, 700, 1000);
		const dj = new DJ();
		await dj.play("burna boy");
		await until(() => !dj.timingLine().includes("pending"), 4000);
		const l = dj.timingLine();
		expect(l).toMatch(
			/^Last play: search 0\.[1-3]s, mpv 0\.[2-4]s, resolve 0\.[3-7]s, first sound 0\.[1-5]s$/,
		);
		expect(l.split("\n")).toHaveLength(1);
	});

	test("a URL played directly has no search stage in the line", async () => {
		timeline(200, 700, 1000);
		const dj = new DJ();
		await dj.play("https://example.invalid/track");
		await until(() => !dj.timingLine().includes("pending"), 4000);
		expect(dj.timingLine()).toMatch(/^Last play: mpv /);
		expect(dj.timingLine()).not.toContain("search");
	});

	test("while mpv is still resolving the line says so", async () => {
		timeline(100, 60_000, 60_001);
		const dj = new DJ();
		await dj.play("https://example.invalid/track");
		await new Promise((r) => setTimeout(r, 400));
		expect(dj.timingLine()).toContain("resolve pending");
	});

	test("mpv is asked for the audio stream only, not the video+audio pair", async () => {
		timeline(100, 700, 1000);
		await new DJ().play("https://example.invalid/track");
		expect(mpvArgs[0]).toContain("--ytdl-format=bestaudio/best");
		expect(mpvArgs[0]).toContain("--no-video");
	});
});
