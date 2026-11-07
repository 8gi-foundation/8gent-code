/**
 * /dj on Android: mpv gets a media URL we resolved, and "Now playing" waits for mpv (#4981).
 *
 * Pixel, Termux: the search worked, mpv's own ytdl hook could not open the YouTube page
 * ("EDL: Could not open source file") and the pane had already said "Now playing". The
 * spawner is swapped for mpv and yt-dlp, and the mpv socket for a fake peer: no network,
 * no real player.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	DJ,
	plainPlayFailure,
	setAudioGraceMs,
	setDjSpawn,
	setDjTools,
	setMpvTransport,
	setPlayConfirmMs,
	setVolumeStore,
} from "../dj";

const PAGE = "https://www.youtube.com/watch?v=abc";
const MEDIA = "https://rr1.googlevideo.example/audio.m4a?sig=1";
const EDL =
	"[ytdl_hook] ERROR: EDL: Could not open source file 'https://www.youtube.com/watch?v=abc'";

interface Seen {
	cmd: string;
	args: string[];
}
const seen: Seen[] = [];
const mpvSeen = () => seen.filter((s) => s.cmd === "/stub/mpv");
const resolves = () => seen.filter((s) => s.cmd === "/stub/yt-dlp" && s.args.includes("-g"));

/** How the stubbed tools behave in one test. */
let mpvSays: { stderr?: string; exit?: boolean } = {};
/** What mpv prints when it is handed the media URL we resolved (the phone path). */
let mpvSaysDirect: { stderr?: string; exit?: boolean } = {};
let ytdlpOut = `${MEDIA}\n`;
let ytdlpErr = "";
let mpvLoads = true;
let lastDirect = false;

function stubSpawn(cmd: string, args: string[]): ChildProcess {
	seen.push({ cmd, args });
	if (cmd === "/stub/mpv") lastDirect = args.includes("--ytdl=no");
	const c = new EventEmitter() as unknown as ChildProcess;
	const out = new EventEmitter();
	const err = new EventEmitter();
	Object.assign(c, { stdout: out, stderr: err, kill: () => true, unref: () => {} });
	if (cmd === "/stub/yt-dlp") {
		setTimeout(() => {
			if (args.some((a) => a.startsWith("ytsearch")))
				out.emit(
					"data",
					`${JSON.stringify({ title: "Fela Kuti - Trouble Sleep", url: PAGE, duration: 300 })}\n`,
				);
			else {
				if (ytdlpOut) out.emit("data", ytdlpOut);
				if (ytdlpErr) err.emit("data", ytdlpErr);
			}
			c.emit("close", ytdlpOut ? 0 : 1);
		}, 0);
	} else {
		setTimeout(() => {
			// mpv fails on the page URL when its hook is broken; a media URL loads.
			const direct = args.includes("--ytdl=no");
			if (mpvSays.stderr && !direct) err.emit("data", `${mpvSays.stderr}\n`);
			if (mpvSays.exit && !direct) c.emit("exit", 1, null);
			if (mpvSaysDirect.stderr && direct) err.emit("data", `${mpvSaysDirect.stderr}\n`);
			if (mpvSaysDirect.exit && direct) c.emit("exit", 1, null);
		}, 20);
	}
	return c;
}

/** A fake mpv socket: answers the track's length once it "loaded" the source. */
function peer() {
	setMpvTransport(async (line) => {
		const prop = JSON.parse(line).command?.[1];
		const ok = (data: unknown) => `${JSON.stringify({ data, error: "success" })}\n`;
		if (prop === "mpv-version") return ok("mpv 0.40.0");
		if (
			prop === "duration" &&
			mpvLoads &&
			!mpvSaysDirect.stderr &&
			!mpvSaysDirect.exit &&
			(!mpvSays.stderr || lastDirect)
		)
			return ok(300);
		return `${JSON.stringify({ error: "property unavailable" })}\n`;
	});
}

const TERMUX = { TERMUX_VERSION: "0.118.3", PREFIX: "/data/data/com.termux/files/usr" };
const savedEnv: Record<string, string | undefined> = {};
function asTermux(on: boolean) {
	for (const [k, v] of Object.entries(TERMUX)) {
		if (!(k in savedEnv)) savedEnv[k] = process.env[k];
		if (on) process.env[k] = v;
		else delete process.env[k];
	}
}

beforeEach(() => {
	seen.length = 0;
	mpvSays = {};
	mpvSaysDirect = {};
	ytdlpOut = `${MEDIA}\n`;
	ytdlpErr = "";
	mpvLoads = true;
	setDjSpawn(stubSpawn);
	setDjTools({ mpv: "/stub/mpv", ytdlp: "/stub/yt-dlp" });
	setVolumeStore({ load: () => null, save: () => {} });
	setAudioGraceMs(0);
	setPlayConfirmMs(600);
	peer();
});
afterEach(() => {
	new DJ().stop();
	setDjSpawn();
	setDjTools();
	setVolumeStore();
	setAudioGraceMs();
	setPlayConfirmMs();
	setMpvTransport();
	asTermux(false);
});

describe("on Android, mpv is handed the media URL", () => {
	test("the URL yt-dlp resolved is what mpv receives, with its own hook off", async () => {
		asTermux(true);
		const result = await new DJ().play("fela kuti trouble sleep");
		expect(result).toBe("Now playing: Fela Kuti - Trouble Sleep");
		expect(resolves()).toHaveLength(1);
		expect(resolves()[0].args).toContain("bestaudio/best");
		expect(resolves()[0].args.at(-1)).toBe(PAGE);
		const args = mpvSeen()[0].args;
		expect(args.at(-1)).toBe(MEDIA);
		expect(args).toContain("--ytdl=no");
		expect(args).not.toContain(PAGE);
	});

	test("yt-dlp cannot resolve: one plain line, mpv never started, no Now playing", async () => {
		asTermux(true);
		ytdlpOut = "";
		ytdlpErr = "ERROR: unable to download video data: HTTP Error 403";
		const result = await new DJ().play("fela kuti trouble sleep");
		expect(result).toBe(
			'Could not play: yt-dlp could not get the stream (cause not checked). yt-dlp said: "ERROR: unable to download video data: HTTP Error 403"',
		);
		expect(result).not.toMatch(/Now playing|EDL|Update|pkg install/);
		expect(result.split("\n")).toHaveLength(1);
		expect(mpvSeen()).toHaveLength(0);
	});

	test("yt-dlp absent and a YouTube link typed: the install step, not an EDL error", async () => {
		asTermux(true);
		setDjTools({ mpv: "/stub/mpv", ytdlp: null });
		const result = await new DJ().play(PAGE);
		expect(result).toBe("yt-dlp not installed. Run: pkg install mpv python-yt-dlp ffmpeg");
		expect(mpvSeen()).toHaveLength(0);
	});
});

describe("Now playing waits for mpv", () => {
	test("a hook failure on the page URL gives the plain line and never Now playing", async () => {
		asTermux(false);
		mpvSays = { stderr: EDL };
		ytdlpOut = ""; // the retry's resolve fails too
		const result = await new DJ().play("fela kuti trouble sleep");
		expect(result).not.toMatch(/Now playing|EDL|Could not open source/);
		expect(result).toMatch(/^Could not play: /);
		expect(result.split("\n")).toHaveLength(1);
	});

	test("a stream complaint names what mpv said, never an update for tools already installed", () => {
		for (const raw of [
			EDL,
			"[ytdl_hook] youtube-dl failed: not found",
			"ytdl_hook: yt-dlp failed",
		]) {
			const line = plainPlayFailure([raw]);
			expect(line).toMatch(
				/^Could not play: mpv could not open the stream \(cause not checked\)\. mpv said: "/,
			);
			expect(line).not.toMatch(/Update|pkg install|\[ytdl_hook\]/);
		}
		expect(plainPlayFailure([])).toBe(
			"Could not play: mpv did not start the track. Run /dj doctor.",
		);
	});

	test("an mpv that never loads the track says so once, after the wait, not Now playing", async () => {
		asTermux(true);
		mpvLoads = false;
		const result = await new DJ().play("fela kuti trouble sleep");
		expect(result).toBe("Could not play: mpv did not start the track. Run /dj doctor.");
	});

	test("success prints Now playing once, after mpv reports the track's length", async () => {
		asTermux(true);
		let asked = 0;
		mpvLoads = false;
		setMpvTransport(async (line) => {
			const prop = JSON.parse(line).command?.[1];
			const ok = (data: unknown) => `${JSON.stringify({ data, error: "success" })}\n`;
			if (prop === "mpv-version") return ok("mpv 0.40.0");
			if (prop === "duration" && ++asked > 3) return ok(300);
			return `${JSON.stringify({ error: "property unavailable" })}\n`;
		});
		const dj = new DJ();
		const result = await dj.play("fela kuti trouble sleep");
		expect(asked).toBeGreaterThan(3); // it waited for mpv, not for the spawn
		expect(result.match(/Now playing/g)).toHaveLength(1);
		expect((await dj.status()).playing).toBe(true);
	});

	test("on a desktop, a broken hook is repaired by resolving and retrying once", async () => {
		asTermux(false);
		mpvSays = { stderr: EDL };
		const result = await new DJ().play("fela kuti trouble sleep");
		expect(result).toBe("Now playing: Fela Kuti - Trouble Sleep");
		const runs = mpvSeen();
		expect(runs).toHaveLength(2);
		expect(runs[0].args.at(-1)).toBe(PAGE); // Mac path unchanged: mpv's own hook first
		expect(runs[0].args).not.toContain("--ytdl=no");
		expect(runs[1].args.at(-1)).toBe(MEDIA);
	});

	test("on a desktop with a working hook, mpv gets the page and yt-dlp is not asked to resolve", async () => {
		asTermux(false);
		const result = await new DJ().play("fela kuti trouble sleep");
		expect(result).toBe("Now playing: Fela Kuti - Trouble Sleep");
		expect(resolves()).toHaveLength(0);
		expect(mpvSeen()[0].args.at(-1)).toBe(PAGE);
	});
});

describe("phone, 7 Nov: yt-dlp found the stream and mpv could not open it", () => {
	const HTTP403 = "[ffmpeg] https: HTTP error 403 Forbidden";
	const OPEN = `[cplayer] Failed to open ${MEDIA}.`;

	test("the line says yt-dlp worked, quotes mpv, and never says update yt-dlp", async () => {
		asTermux(true);
		mpvSaysDirect = { stderr: `${HTTP403}\n${OPEN}`, exit: true };
		const result = await new DJ().play("roots reggae");
		expect(result).toBe(
			'Could not play: yt-dlp found the stream, but mpv could not open it (cause not checked). mpv said: "https: HTTP error 403 Forbidden"',
		);
		expect(result).not.toMatch(/Update|pkg install|Now playing/);
		// The signed media URL never reaches the screen.
		expect(result).not.toContain("googlevideo");
		expect(result.split("\n")).toHaveLength(1);
	});

	test("a yt-dlp warning from a resolve that worked is kept for the failure line", async () => {
		asTermux(true);
		ytdlpErr = "WARNING: [youtube] No supported JavaScript runtime could be found\n";
		mpvSaysDirect = { stderr: OPEN, exit: true };
		const result = await new DJ().play("roots reggae");
		expect(result).toContain("yt-dlp found the stream, but mpv could not open it");
		expect(result).toContain('mpv said: "Failed to open <url>"');
		expect(result).toContain('yt-dlp warned: "No supported JavaScript runtime could be found"');
	});

	test("mpv printed nothing it could quote: it says so instead of guessing", async () => {
		asTermux(true);
		mpvSaysDirect = { exit: true };
		const result = await new DJ().play("roots reggae");
		expect(result).toMatch(/^Could not play: /);
		expect(result).not.toMatch(/Update|pkg install|Now playing/);
	});
});
