/**
 * DJ guardrail (#2934, part of #2922).
 *
 * DJ is the backend behind /dj and the 8GENT FM deck. It keeps module-level
 * state (tool cache, mpv handle, queue, history) and resolves its socket and
 * resume paths at import, so this suite imports a private copy of the module
 * (Bun treats a query-string specifier as a distinct instance) after pointing
 * TMPDIR and PATH at the fixture. mpv, yt-dlp, sox and ffmpeg are the fake
 * executables; the Radio Browser API is a fake fetch. A live mpv from the
 * developer's own TUI is never reached: the IPC socket path lives in the
 * throwaway TMPDIR.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { DJ as DJClass } from "../dj.js";
import { type FakeTools, installFakeTools } from "./fake-tools.js";

type DJModule = { DJ: typeof DJClass };

const realTmpdir = process.env.TMPDIR;
let isolatedTmp: string;
let tools: FakeTools;
let dj: DJClass;
let bare: DJClass;
let requests: string[] = [];
const realFetch = globalThis.fetch;

// The DJ persists resume state at ~/.8gent/dj-resume.json (HOME is whatever
// the launcher gave this process; `bun run music:smoke` supplies a throwaway
// one). Never clobber a developer's real resume file.
const RESUME_PATH = join(homedir(), ".8gent", "dj-resume.json");
const resumeFileExisted = existsSync(RESUME_PATH);

function fakeRadio(stations: Array<Record<string, unknown>> | Error): void {
	requests = [];
	globalThis.fetch = (async (input: string | URL) => {
		requests.push(typeof input === "string" ? input : input.toString());
		if (stations instanceof Error) throw stations;
		return { json: async () => stations } as unknown as Response;
	}) as unknown as typeof fetch;
}

beforeAll(async () => {
	isolatedTmp = mkdtempSync(join(tmpdir(), "8gent-dj-tmp-"));
	process.env.TMPDIR = isolatedTmp;
	tools = installFakeTools("8gent-dj-");

	const specifier = "../dj.ts?guardrail";
	const mod = (await import(specifier)) as DJModule;
	dj = new mod.DJ();

	// A second private instance constructed with no tools on PATH at all.
	const savedPath = process.env.PATH;
	process.env.PATH = "/usr/bin:/bin";
	const bareSpecifier = "../dj.ts?guardrail-bare";
	const bareMod = (await import(bareSpecifier)) as DJModule;
	bare = new bareMod.DJ();
	process.env.PATH = savedPath;
});

afterAll(() => {
	dj.stop();
	globalThis.fetch = realFetch;
	tools.restore();
	if (realTmpdir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = realTmpdir;
	rmSync(isolatedTmp, { recursive: true, force: true });
});

beforeEach(() => {
	tools.reset();
	tools.setEnv("FAKE_FFMPEG_EXIT", undefined);
	tools.setEnv("FAKE_FFMPEG_STDOUT_FILE", undefined);
	tools.setEnv("FAKE_YTDLP_STDOUT_FILE", undefined);
	tools.setEnv("FAKE_YTDLP_EXIT", undefined);
});

describe("DJ tool detection", () => {
	test("doctor reports every tool present and the install command", () => {
		expect(dj.doctor()).toEqual({
			mpv: true,
			ytdlp: true,
			ffmpeg: true,
			sox: true,
			installCmd: "brew install mpv yt-dlp ffmpeg sox",
		});
	});

	test("without tools every capability explains what to install", async () => {
		expect(bare.doctor().mpv).toBe(false);
		expect(await bare.play("anything")).toBe("mpv not installed. Run: brew install mpv");
		expect(await bare.radio("lofi")).toBe("mpv not installed. Run: brew install mpv");
		expect(bare.download("https://x.test/a")).toBe("yt-dlp not installed.");
		expect(bare.bpm(tools.file("bare.wav"))).toBe("sox not installed.");
		expect(bare.mix(tools.file("a.wav"), tools.file("b.wav"))).toBe("ffmpeg not installed.");
		expect(tools.calls()).toEqual([]);
	});
});

describe("DJ radio presets", () => {
	test("exposes the preset list the /dj presets command prints", () => {
		const presets = dj.radioPresets();
		expect(presets).toHaveLength(21);
		expect(presets).toEqual(expect.arrayContaining(["lofi", "chill", "jazz", "dnb", "hiphop"]));
	});
});

describe("DJ idle state", () => {
	test("reports nothing playing", async () => {
		expect(await dj.nowPlaying()).toBe("Nothing playing.");
		expect(await dj.pause()).toBe("Nothing playing.");
		expect(await dj.volume(40)).toBe("Nothing playing.");
		const status = await dj.status();
		expect(status).toEqual({
			playing: false,
			paused: false,
			looping: false,
			title: "",
			url: "",
			position: null,
			duration: null,
			volume: null,
			queueSize: 0,
		});
	});

	test("repeat toggles and reports", () => {
		expect(dj.repeat()).toBe("Repeat ON");
		expect(dj.repeat()).toBe("Repeat OFF");
	});

	test("queue counts entries and stop clears them", async () => {
		expect(dj.queue("first song")).toBe("Queued: first song (1 in queue)");
		expect(dj.queue("https://x.test/second")).toBe("Queued: https://x.test/second (2 in queue)");
		expect((await dj.status()).queueSize).toBe(2);
		expect(dj.stop()).toBe("Stopped.");
		expect((await dj.status()).queueSize).toBe(0);
		expect(await dj.skip()).toBe("Queue empty. Stopped.");
	});
});

describe("DJ file tools", () => {
	test("download hands the URL to yt-dlp as mp3 into the music folder", () => {
		const result = dj.download("https://soundcloud.test/track");
		const musicDir = join(homedir(), "Music", "8gent");
		expect(result).toBe(`Downloaded to ${musicDir}`);
		expect(tools.callsFor("yt-dlp")[0].args).toEqual([
			"-x",
			"--audio-format",
			"mp3",
			"-o",
			`${musicDir}/%(title)s.%(ext)s`,
			"https://soundcloud.test/track",
		]);
	});

	test("download reports a failing yt-dlp", () => {
		tools.setEnv("FAKE_YTDLP_EXIT", "3");
		expect(dj.download("https://x.test/a").startsWith("Download failed:")).toBe(true);
	});

	test("bpm estimates tempo from the inter-onset interval", () => {
		const wav = tools.file("beat.wav", "riff");
		const onsets = [0, 0.5, 1.0, 1.5, 2.0, 2.5];
		tools.setEnv(
			"FAKE_FFMPEG_STDOUT_FILE",
			tools.file("onsets.txt", onsets.map((t) => `[x] pts_time:${t} y`).join("\n")),
		);
		expect(dj.bpm(wav)).toBe("Estimated BPM: 120");
		// sox streams raw float mono at 44.1k into ffmpeg's onset filter.
		expect(tools.callsFor("sox")[0].args).toEqual([
			wav,
			"-t",
			"raw",
			"-r",
			"44100",
			"-e",
			"float",
			"-c",
			"1",
			"-",
		]);
		expect(tools.callsFor("ffmpeg")[0].args).toContain("f32le");
	});

	test("bpm follows the onset spacing", () => {
		const wav = tools.file("beat2.wav", "riff");
		const onsets = [0, 0.4, 0.8, 1.2];
		tools.setEnv(
			"FAKE_FFMPEG_STDOUT_FILE",
			tools.file("onsets2.txt", onsets.map((t) => `pts_time:${t}`).join("\n")),
		);
		expect(dj.bpm(wav)).toBe("Estimated BPM: 150");
	});

	test("bpm needs at least four onsets and an existing file", () => {
		const wav = tools.file("beat3.wav", "riff");
		tools.setEnv("FAKE_FFMPEG_STDOUT_FILE", tools.file("onsets3.txt", "pts_time:0\npts_time:1\n"));
		expect(dj.bpm(wav)).toBe("Could not detect BPM (too few onsets).");
		expect(dj.bpm(`${tools.scratch}/missing.wav`)).toBe(
			`File not found: ${tools.scratch}/missing.wav`,
		);
	});

	test("mix crossfades two files with ffmpeg", () => {
		const a = tools.file("a.mp3", "x");
		const b = tools.file("b.mp3", "y");
		const result = dj.mix(a, b, 7);
		expect(result.startsWith(`Mixed: ${join(homedir(), "Music", "8gent")}/mix-`)).toBe(true);
		expect(result.endsWith(".mp3")).toBe(true);
		const [call] = tools.callsFor("ffmpeg");
		expect(call.args.slice(0, 5)).toEqual(["-y", "-i", a, "-i", b]);
		const filter = call.args[call.args.indexOf("-filter_complex") + 1];
		expect(filter).toBe(
			"[0:a]afade=t=out:st=0:d=7[a0];[1:a]afade=t=in:st=0:d=7[a1];[a0][a1]acrossfade=d=7[out]",
		);
		expect(call.args[call.args.indexOf("-map") + 1]).toBe("[out]");
	});

	test("mix reports missing files and ffmpeg failures", () => {
		const a = tools.file("c.mp3", "x");
		expect(dj.mix(a, `${tools.scratch}/nope.mp3`)).toBe("One or both files not found.");
		tools.setEnv("FAKE_FFMPEG_EXIT", "1");
		expect(dj.mix(a, a)).toBe("Mix failed.");
	});
});

describe("DJ playback (fake mpv)", () => {
	test("play with a URL launches mpv with the IPC server and tracks state", async () => {
		const url = "https://youtube.test/watch?v=abc";
		expect(await dj.play(url)).toBe(`Now playing: ${url}`);

		const [mpv] = tools.callsFor("mpv");
		expect(mpv.args).toEqual([
			"--no-video",
			"--idle=yes",
			`--input-ipc-server=${join(isolatedTmp, "mpv-8gent-dj.sock")}`,
			`--title=${url}`,
			url,
		]);
		expect(tools.callsFor("yt-dlp")).toEqual([]);

		expect(await dj.nowPlaying()).toBe(`Playing: ${url}`);
		dj.queue("next one");
		expect(await dj.nowPlaying()).toBe(`Playing: ${url} (+1 queued)`);
		const status = await dj.status();
		expect(status.playing).toBe(true);
		expect(status.title).toBe(url);
		expect(status.url).toBe(url);
		expect(status.queueSize).toBe(1);
		expect(dj.getHistory().at(-1)?.url).toBe(url);

		expect(await dj.pause()).toBe("Paused.");
		expect(await dj.nowPlaying()).toBe(`Playing: ${url} (+1 queued)`.replace("Playing", "Paused"));
		expect(await dj.pause()).toBe("Resumed.");
		expect(await dj.volume(70)).toBe("Volume: 70%");

		expect(dj.stop()).toBe("Stopped.");
		expect((await dj.status()).playing).toBe(false);
		expect((await dj.status()).queueSize).toBe(0);
	}, 10000);

	test("play with a query searches YouTube through yt-dlp first", async () => {
		tools.setEnv(
			"FAKE_YTDLP_STDOUT_FILE",
			tools.file("search.txt", "Found Song\thttps://youtube.test/watch?v=found\n"),
		);
		expect(await dj.play("found song please")).toBe("Now playing: Found Song");
		expect(tools.callsFor("yt-dlp")[0].args).toEqual([
			"--print",
			"%(title)s\t%(webpage_url)s",
			"ytsearch1:found song please",
		]);
		const [mpv] = tools.callsFor("mpv");
		expect(mpv.args[3]).toBe("--title=Found Song");
		expect(mpv.args[4]).toBe("https://youtube.test/watch?v=found");
		dj.stop();
	}, 10000);

	test("a failed search reports no results", async () => {
		tools.setEnv("FAKE_YTDLP_EXIT", "1");
		expect(await dj.play("nothing here")).toBe("No results found for: nothing here");
		expect(tools.callsFor("mpv")).toEqual([]);
	});

	test("skip plays the next queued item", async () => {
		dj.queue("https://youtube.test/watch?v=queued");
		expect(await dj.skip()).toBe("Now playing: https://youtube.test/watch?v=queued");
		expect((await dj.status()).queueSize).toBe(0);
		dj.stop();
	}, 10000);
});

describe("DJ radio (fake Radio Browser API)", () => {
	test("maps a preset to its search term and streams the top-voted station", async () => {
		fakeRadio([
			{ name: "Chill Beats", country: "Ireland", url_resolved: "https://stream.test/chill" },
			{ name: "Lo-Fi Cafe", country: "Japan", url: "https://stream.test/cafe" },
			{ name: "Study FM", country: "Germany", url: "https://stream.test/study" },
		]);
		expect(await dj.radio("lofi")).toBe("Radio: Chill Beats (Ireland)\nAlso: Lo-Fi Cafe, Study FM");
		expect(requests).toEqual([
			"https://de1.api.radio-browser.info/json/stations/search?name=lo-fi&limit=5&order=votes&reverse=true",
		]);
		const [mpv] = tools.callsFor("mpv");
		expect(mpv.args).toEqual([
			"--no-video",
			`--input-ipc-server=${join(isolatedTmp, "mpv-8gent-dj.sock")}`,
			"--title=Chill Beats",
			"https://stream.test/chill",
		]);
		expect((await dj.status()).title).toBe("Chill Beats");
		dj.stop();
	}, 10000);

	test("falls back to the station url and searches free text verbatim", async () => {
		fakeRadio([{ name: "Solo", country: "Spain", url: "https://stream.test/solo" }]);
		expect(await dj.radio("Drum and Bass")).toBe("Radio: Solo (Spain)\nAlso: none");
		expect(requests[0]).toContain("name=Drum%20and%20Bass");
		expect(tools.callsFor("mpv")[0].args.at(-1)).toBe("https://stream.test/solo");
		dj.stop();
	}, 10000);

	test("a direct stream URL skips the search", async () => {
		fakeRadio(new Error("must not be called"));
		expect(await dj.radio("http://stream.test/direct")).toBe(
			"Radio streaming: http://stream.test/direct",
		);
		expect(requests).toEqual([]);
		expect((await dj.status()).title).toBe("Radio: http://stream.test/direct");
		dj.stop();
	}, 10000);

	test("no stations and API failures are reported, not thrown", async () => {
		fakeRadio([]);
		expect(await dj.radio("zzz")).toBe("No radio stations found for: zzz");
		fakeRadio(new Error("offline"));
		expect(await dj.radio("jazz")).toBe("Radio search failed: offline");
		expect(tools.callsFor("mpv")).toEqual([]);
	});
});

describe("DJ resume", () => {
	test("reports nothing to resume when no state was saved", async () => {
		if (resumeFileExisted) return;
		expect(await dj.resume()).toBe("Nothing to resume.");
	});

	test.skipIf(resumeFileExisted)(
		"resumes a saved track at its position",
		async () => {
			mkdirSync(join(homedir(), ".8gent"), { recursive: true });
			try {
				writeFileSync(
					RESUME_PATH,
					JSON.stringify({
						title: "Saved Song",
						url: "https://youtube.test/watch?v=saved",
						positionSec: 95,
						timestamp: Date.now(),
					}),
				);
				expect(await dj.resume()).toBe("Resumed: Saved Song at 1:35");
				expect(tools.callsFor("mpv")[0].args.at(-1)).toBe("https://youtube.test/watch?v=saved");
				dj.stop();
			} finally {
				unlinkSync(RESUME_PATH);
			}
		},
		10000,
	);

	test.skipIf(resumeFileExisted)("ignores resume state older than a day", async () => {
		mkdirSync(join(homedir(), ".8gent"), { recursive: true });
		try {
			writeFileSync(
				RESUME_PATH,
				JSON.stringify({
					title: "Old",
					url: "https://youtube.test/watch?v=old",
					positionSec: 10,
					timestamp: Date.now() - 2 * 86400000,
				}),
			);
			expect(await dj.resume()).toBe("Nothing to resume.");
			expect(tools.callsFor("mpv")).toEqual([]);
		} finally {
			unlinkSync(RESUME_PATH);
		}
	});
});
