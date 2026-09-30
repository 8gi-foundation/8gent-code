/**
 * The DJ stops only what it started, searches without freezing, and
 * remembers the volume (#3183, #3182, #3190).
 *
 * Every process the DJ and the music Player start goes through a spawn seam,
 * swapped here for a stub that records the call and hands back a fake child.
 * No real mpv, yt-dlp or afplay runs, and nothing here can signal a process
 * it did not create.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_VOLUME,
	DJ,
	clampVolume,
	setDjSpawn,
	setDjTools,
	setVolumeStore,
	writeVolumeSetting,
	ytSearch,
} from "../dj";
import { Player, setPlayerSpawn, stopOwnPlayers } from "../player";

interface FakeChild extends EventEmitter {
	cmd: string;
	args: string[];
	pid: number;
	stdout: EventEmitter;
	signals: (string | number | undefined)[];
	kill(sig?: string | number): boolean;
	unref(): void;
}

let nextPid = 90000;
const spawned: FakeChild[] = [];

function fakeChild(cmd: string, args: string[]): FakeChild {
	const c = new EventEmitter() as FakeChild;
	c.cmd = cmd;
	c.args = args;
	c.pid = nextPid++;
	c.stdout = new EventEmitter();
	c.signals = [];
	c.kill = (sig) => {
		c.signals.push(sig);
		setTimeout(() => c.emit("exit", null, sig ?? "SIGTERM"), 0);
		return true;
	};
	c.unref = () => {};
	return c;
}

/** yt-dlp answers its search after `searchMs`; every other command just starts. */
function stubSpawn(
	searchMs = 0,
	answer = "Fela Kuti - No Agreement\thttps://www.youtube.com/watch?v=abc",
): (cmd: string, args: string[]) => ChildProcess {
	return (cmd: string, args: string[]) => {
		const c = fakeChild(cmd, args);
		spawned.push(c);
		if (args.some((a) => a.startsWith("ytsearch1:"))) {
			setTimeout(() => {
				c.stdout.emit("data", `${answer}\n`);
				c.emit("close", 0);
			}, searchMs);
		}
		return c as unknown as ChildProcess;
	};
}

function memoryStore(initial: number | null = null) {
	const store = {
		value: initial as number | null,
		saves: [] as number[],
		load: () => store.value,
		save: (v: number) => {
			store.value = v;
			store.saves.push(v);
		},
	};
	return store;
}

const byName = /\b(pkill|killall)\b/;

beforeEach(() => {
	spawned.length = 0;
	setDjSpawn(stubSpawn());
	setPlayerSpawn(stubSpawn());
	setDjTools({ mpv: "/stub/mpv", ytdlp: "/stub/yt-dlp" });
	setVolumeStore(memoryStore());
});

afterEach(() => {
	new DJ().stop();
	setDjSpawn();
	setPlayerSpawn();
	setDjTools();
	setVolumeStore();
});

describe("/dj stop signals only the DJ's own children (#3183)", () => {
	test("stopOwnPlayers ends the afplay children this process started, and nothing else", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dj-stop-"));
		const file = join(dir, "t.wav");
		writeFileSync(file, "");
		const a = new Player();
		const b = new Player();
		a.play(file);
		b.playLoop(file);
		const foreign = fakeChild("afplay", ["someone-elses.m4a"]);

		expect(stopOwnPlayers()).toBe(2);
		await new Promise((r) => setTimeout(r, 5));

		const afplays = spawned.filter((c) => c.cmd === "afplay");
		expect(afplays).toHaveLength(2);
		for (const c of afplays) expect(c.signals).toHaveLength(1);
		// The loop does not restart after its own stop.
		expect(spawned.filter((c) => c.cmd === "afplay")).toHaveLength(2);
		expect(foreign.signals).toHaveLength(0);
		expect(spawned.some((c) => byName.test(c.cmd))).toBe(false);
		expect(stopOwnPlayers()).toBe(0);
	});

	test("DJ.stop ends its mpv and the producer's afplay by their own handles, never by name", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dj-stop-"));
		const file = join(dir, "t.wav");
		writeFileSync(file, "");
		const dj = new DJ();
		await dj.play("https://example.invalid/track");
		const producer = new Player();
		producer.playLoop(file);

		expect(dj.stop()).toBe("Stopped.");
		await new Promise((r) => setTimeout(r, 5));

		const mpv = spawned.find((c) => c.cmd === "/stub/mpv");
		const afplay = spawned.find((c) => c.cmd === "afplay");
		expect(mpv?.signals).toEqual(["SIGTERM"]);
		expect(afplay?.signals).toHaveLength(1);
		expect(spawned.map((c) => c.cmd).filter((c) => byName.test(c))).toEqual([]);
	});

	test("no name-pattern kill is left in packages/music or the DJ surfaces", () => {
		const root = join(import.meta.dir, "..", "..", "..");
		const read = (p: string) => readFileSync(join(root, p), "utf-8");
		for (const p of [
			"packages/music/dj.ts",
			"packages/music/player.ts",
			"packages/music/producer.ts",
			"packages/music/mixer.ts",
			"packages/music/sox-synth.ts",
			"packages/music/key-detect.ts",
			"packages/music/replicate.ts",
			"apps/tui/src/hooks/useDJ.ts",
			"apps/tui/src/components/DjDeck.tsx",
		]) {
			expect({ p, hit: byName.test(read(p)) }).toEqual({ p, hit: false });
		}
		const app = read("apps/tui/src/app.tsx");
		const djCase = app.slice(app.indexOf('case "dj": {'), app.indexOf('case "pet": {'));
		expect(djCase.length).toBeGreaterThan(100);
		expect(byName.test(djCase)).toBe(false);
	});
});

describe("/dj play searches off the event loop (#3182)", () => {
	test("the TUI keeps getting turns while yt-dlp searches", async () => {
		setDjSpawn(stubSpawn(400));
		let turns = 0;
		const beat = setInterval(() => turns++, 10);
		const t0 = performance.now();
		const result = await new DJ().play("Fela Kuti no agreement");
		clearInterval(beat);
		expect(result).toBe("Now playing: Fela Kuti - No Agreement");
		// 400 ms search + 1500 ms IPC wait at a 10 ms beat: a blocked loop gets ~0 turns there.
		expect(turns).toBeGreaterThan((performance.now() - t0) / 10 / 2);
		const search = spawned.find((c) => c.args.includes("ytsearch1:Fela Kuti no agreement"));
		expect(search?.cmd).toBe("/stub/yt-dlp");
		expect(spawned.find((c) => c.cmd === "/stub/mpv")?.args).toContain(
			"https://www.youtube.com/watch?v=abc",
		);
	});

	test("a stop while the search runs wins: no player starts afterwards", async () => {
		setDjSpawn(stubSpawn(200));
		const dj = new DJ();
		const pending = dj.play("Fela Kuti no agreement");
		await new Promise((r) => setTimeout(r, 20));
		dj.stop();
		expect(await pending).toBe("Stopped.");
		expect(spawned.some((c) => c.cmd === "/stub/mpv")).toBe(false);
	});

	test("no result, or a search that fails, says so", async () => {
		setDjSpawn(stubSpawn(0, ""));
		expect(await new DJ().play("zzzz")).toBe("No results found for: zzzz");
		expect(await ytSearch("/stub/yt-dlp", "zzzz")).toBeNull();
	});
});

describe("the volume is remembered (#3190)", () => {
	test("a first-ever track starts at the default, not 100%", async () => {
		await new DJ().play("https://example.invalid/a");
		const mpv = spawned.find((c) => c.cmd === "/stub/mpv");
		expect(DEFAULT_VOLUME).toBe(60);
		expect(mpv?.args).toContain("--volume=60");
	});

	test("a chosen volume carries to the next track and is stored; mute is not", async () => {
		const store = memoryStore();
		setVolumeStore(store);
		const dj = new DJ();
		expect(await dj.volume(35)).toBe("Volume: 35% (for the next track)");
		await dj.play("https://example.invalid/a");
		await dj.volume(0);
		dj.stop();
		await dj.play("https://example.invalid/b");
		const mpvs = spawned.filter((c) => c.cmd === "/stub/mpv");
		expect(mpvs.map((c) => c.args[0])).toEqual(["--volume=35", "--volume=35"]);
		expect(store.saves).toEqual([35]);
		expect(dj.preferredVolume()).toBe(35);
	});

	test("storing the volume changes music.volume and nothing else in settings.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "dj-vol-"));
		const file = join(dir, "settings.json");
		const before = {
			version: 1,
			voice: { ttsVoice: "Ava" },
			connectors: { gmail: { on: true } },
			briefings: { music: "on" },
			music: { volume: 60, other: "kept" },
		};
		writeFileSync(file, JSON.stringify(before));
		writeVolumeSetting(file, 42);
		expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
			...before,
			music: { volume: 42, other: "kept" },
		});
		// No file yet: it is created with just the volume.
		const fresh = join(dir, "sub", "settings.json");
		writeVolumeSetting(fresh, 55);
		expect(JSON.parse(readFileSync(fresh, "utf-8"))).toEqual({ music: { volume: 55 } });
		// A file that is not a JSON object is never overwritten.
		writeFileSync(file, "[1,2]");
		writeVolumeSetting(file, 10);
		expect(readFileSync(file, "utf-8")).toBe("[1,2]");
	});

	test("a stored value out of range or not a number falls back safely", () => {
		expect(clampVolume(500)).toBe(150);
		expect(clampVolume(-4)).toBe(0);
		expect(clampVolume("loud")).toBe(DEFAULT_VOLUME);
		expect(clampVolume(Number.NaN)).toBe(DEFAULT_VOLUME);
	});
});
