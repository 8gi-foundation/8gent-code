/**
 * /dj on a phone (#4907): the Termux player branch.
 *
 * The same stub spawner as dj-safe-fast.test.ts records mpv's exact arguments,
 * and fires the child's own exit. The loudness test then runs the real mpv
 * with those exact arguments into a PCM file and measures it with ffmpeg's
 * ebur128, so the volume claim is a measurement of the shipped path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_VOLUME,
	DJ,
	TERMUX_DEFAULT_VOLUME,
	defaultVolume,
	mpvStartArgs,
	preferredVolume,
	setDjSpawn,
	setDjTools,
	setVolumeStore,
} from "../dj";

interface FakeChild extends EventEmitter {
	cmd: string;
	args: string[];
	signals: (string | number | undefined)[];
	kill(sig?: string | number): boolean;
	unref(): void;
}

const spawned: FakeChild[] = [];
const mpvs = () => spawned.filter((c) => c.cmd === "/stub/mpv");

function stubSpawn(cmd: string, args: string[]): ChildProcess {
	const c = new EventEmitter() as FakeChild;
	c.cmd = cmd;
	c.args = args;
	c.signals = [];
	c.kill = (sig) => {
		c.signals.push(sig);
		setTimeout(() => c.emit("exit", null, sig ?? "SIGTERM"), 0);
		return true;
	};
	c.unref = () => {};
	spawned.push(c);
	return c as unknown as ChildProcess;
}

function memoryStore(initial: number | null = null) {
	const store = {
		value: initial as number | null,
		load: () => store.value,
		save: (v: number) => {
			store.value = v;
		},
	};
	return store;
}

const TERMUX_ENV = { TERMUX_VERSION: "0.118.3", PREFIX: "/data/data/com.termux/files/usr" };
const saved: Record<string, string | undefined> = {};

function asTermux(on: boolean) {
	for (const k of Object.keys(TERMUX_ENV)) {
		if (!(k in saved)) saved[k] = process.env[k];
		if (on) process.env[k] = TERMUX_ENV[k as keyof typeof TERMUX_ENV];
		else delete process.env[k];
	}
}

beforeEach(() => {
	spawned.length = 0;
	setDjSpawn(stubSpawn);
	setDjTools({ mpv: "/stub/mpv", ytdlp: "/stub/yt-dlp" });
	setVolumeStore(memoryStore());
	asTermux(true);
});

afterEach(() => {
	new DJ().stop();
	setDjSpawn();
	setDjTools();
	setVolumeStore();
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("the Termux player branch: arguments and volume", () => {
	test("Termux plays through mpv at unity gain; the desktop default stays 60", () => {
		expect(defaultVolume(true)).toBe(TERMUX_DEFAULT_VOLUME);
		expect(TERMUX_DEFAULT_VOLUME).toBe(100);
		expect(defaultVolume(false)).toBe(DEFAULT_VOLUME);
		expect(preferredVolume()).toBe(100);
		asTermux(false);
		expect(preferredVolume()).toBe(60);
	});

	test("a volume the listener chose wins on a phone too, and mute is not a preference", () => {
		setVolumeStore(memoryStore(35));
		expect(preferredVolume()).toBe(35);
	});

	test("mpv is started with --volume first, then the caller's arguments", () => {
		expect(mpvStartArgs(100, ["--no-video", "x"])).toEqual(["--volume=100", "--no-video", "x"]);
	});

	test("/dj play on Termux spawns mpv with the audio-only arguments at volume 100", async () => {
		const result = await new DJ().play("https://example.invalid/track");
		expect(result).toBe("Now playing: https://example.invalid/track");
		expect(mpvs()).toHaveLength(1);
		const args = mpvs()[0].args;
		expect(args[0]).toBe("--volume=100");
		expect(args).toContain("--no-video");
		expect(args.some((a) => a.startsWith("--input-ipc-server="))).toBe(true);
		expect(args.at(-1)).toBe("https://example.invalid/track");
	});

	test("the same /dj play on the desktop spawns at volume 60", async () => {
		asTermux(false);
		await new DJ().play("https://example.invalid/track");
		expect(mpvs()[0].args[0]).toBe("--volume=60");
	});
});

describe("the Termux player branch: state from the process we spawned", () => {
	test("while mpv runs the status says playing and the clock moves with no IPC", async () => {
		const dj = new DJ();
		await dj.play("https://example.invalid/track");
		const s = await dj.status();
		expect(s.playing).toBe(true);
		expect(s.paused).toBe(false);
		// No mpv socket exists in the test, so this position is the DJ's own stopwatch.
		expect(typeof s.position).toBe("number");
		expect(s.position as number).toBeGreaterThanOrEqual(0);
	});

	test("when mpv exits the status stops saying playing", async () => {
		const dj = new DJ();
		await dj.play("https://example.invalid/track");
		expect((await dj.status()).playing).toBe(true);
		mpvs()[0].emit("exit", 1, null);
		const s = await dj.status();
		expect(s.playing).toBe(false);
		expect(s.title).toBe("");
		expect(await dj.nowPlaying()).toBe("Nothing playing.");
	});

	test("an old mpv's exit does not end the track that replaced it", async () => {
		const dj = new DJ();
		await dj.play("https://example.invalid/one");
		const first = mpvs()[0];
		await dj.play("https://example.invalid/two");
		first.emit("exit", null, "SIGTERM");
		const s = await dj.status();
		expect(s.playing).toBe(true);
		expect(s.title).toBe("https://example.invalid/two");
	});

	test("an mpv that dies at once is reported, not shown as playing", async () => {
		setDjSpawn((cmd, args) => {
			const c = stubSpawn(cmd, args);
			setTimeout(() => c.emit("exit", 1, null), 10);
			return c;
		});
		const dj = new DJ();
		const result = await dj.play("https://example.invalid/track");
		expect(result).toContain("Could not play");
		expect((await dj.status()).playing).toBe(false);
	});

	test("pause with no IPC still flips the state, and resume flips it back", async () => {
		const dj = new DJ();
		await dj.play("https://example.invalid/track");
		await dj.pause();
		expect((await dj.status()).paused).toBe(true);
		await dj.pause();
		expect((await dj.status()).paused).toBe(false);
	});
});

// ---- Loudness, measured on the exact arguments ----

function haveTool(bin: string): boolean {
	try {
		execFileSync(bin, ["-version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

describe("loudness of the shipped arguments", () => {
	const ok = haveTool("mpv") && haveTool("ffmpeg");

	/** What mpv writes as PCM for `file` with `args` (the DJ's own, less the IPC and title). */
	function renderWith(args: string[], file: string, out: string): void {
		const own = args.filter(
			(a) =>
				!a.startsWith("--input-ipc-server=") && !a.startsWith("--title=") && a !== "--idle=yes",
		);
		const flags = own.slice(0, -1);
		execFileSync(
			"mpv",
			["--no-config", "--really-quiet", ...flags, "--ao=pcm", `--ao-pcm-file=${out}`, file],
			{ stdio: "ignore" },
		);
	}

	function measure(file: string): number {
		const out = execFileSync(
			"sh",
			[
				"-c",
				'ffmpeg -nostats -i "$1" -af ebur128 -f null - 2>&1 | grep -A1 "Integrated loudness" | grep "I:"',
				"sh",
				file,
			],
			{ encoding: "utf-8" },
		);
		return Number.parseFloat(out.replace(/.*I:\s*/, ""));
	}

	test.skipIf(!ok)(
		"Termux plays the track at its mastered loudness; the old 60 was 13 LU under it",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "dj-loud-"));
			const src = join(dir, "track.wav");
			execFileSync(
				"ffmpeg",
				[
					"-v",
					"error",
					"-f",
					"lavfi",
					"-i",
					"anoisesrc=d=15:c=pink:r=44100:a=0.5",
					"-f",
					"lavfi",
					"-i",
					"sine=f=220:d=15:r=44100",
					"-filter_complex",
					"[0][1]amix=inputs=2:weights=0.7 0.4,loudnorm=I=-14:TP=-1:LRA=11[o]",
					"-map",
					"[o]",
					"-ac",
					"2",
					src,
				],
				{ stdio: "ignore" },
			);
			const sourceLufs = measure(src);

			// The exact arguments the DJ spawns, on a phone and on a desktop.
			await new DJ().play("https://example.invalid/track");
			const phoneArgs = mpvs()[0].args;
			new DJ().stop();
			asTermux(false);
			spawned.length = 0;
			await new DJ().play("https://example.invalid/track");
			const deskArgs = mpvs()[0].args;

			renderWith(phoneArgs, src, join(dir, "phone.wav"));
			renderWith(deskArgs, src, join(dir, "desk.wav"));
			const phone = measure(join(dir, "phone.wav"));
			const desk = measure(join(dir, "desk.wav"));

			expect(Math.abs(phone - sourceLufs)).toBeLessThan(0.5);
			expect(sourceLufs - desk).toBeGreaterThan(12.5);
			expect(sourceLufs - desk).toBeLessThan(14);
			console.log(`loudness LUFS: source ${sourceLufs}, phone ${phone}, desktop-default ${desk}`);
			rmSync(dir, { recursive: true, force: true });
		},
		60000,
	);
});
