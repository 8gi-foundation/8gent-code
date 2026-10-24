/**
 * /dj says "playing" only when mpv does (#4907, phone: "it says playing but no sound").
 *
 * A fake mpv IPC peer listens on the DJ's real socket path and answers get_property and
 * set_property the way mpv does, so the DJ's own client talks to it over a real unix
 * socket. The spawned player is a stub; its output is fed in by the test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import * as net from "node:net";
import { dirname } from "node:path";
import {
	type AudioHealth,
	DJ,
	diagnoseAudio,
	mpvIpcPath,
	mpvStartArgs,
	notePlayerOutput,
	setAudioGraceMs,
	setDjSpawn,
	setDjTools,
	setMpvTransport,
	setVolumeStore,
} from "../dj";

// ---- the fake mpv ----
type Props = Record<string, unknown>;
let props: Props = {};
let server: net.Server | null = null;
const sets: [string, unknown][] = [];

function healthy(): Props {
	return {
		"mpv-version": "mpv 0.40.0",
		"idle-active": false,
		"current-ao": "opensles",
		"playback-time": 12.5,
		"time-pos": 12.5,
		duration: 200,
		volume: 100,
		mute: false,
		pause: false,
	};
}

/** mpv's answer to one command line, as it would write it. */
function answer(line: string): string {
	const { command } = JSON.parse(line) as { command: [string, string, unknown?] };
	let reply: Record<string, unknown>;
	if (command[0] === "get_property") {
		reply =
			command[1] in props && props[command[1]] !== null
				? { data: props[command[1]], error: "success" }
				: { error: "property unavailable" };
	} else if (command[0] === "set_property") {
		props[command[1]] = command[2];
		sets.push([command[1], command[2]]);
		reply = { error: "success" };
	} else if (command[0] === "cycle" && command[1] === "pause") {
		props.pause = !props.pause;
		reply = { error: "success" };
	} else reply = { error: "success" };
	// mpv interleaves event lines with the reply.
	return `${JSON.stringify({ event: "tick" })}\n${JSON.stringify(reply)}\n`;
}

/** The fake peer: in process by default (a sandbox may forbid binding a socket). */
async function startPeer(initial: Props): Promise<void> {
	props = initial;
	sets.length = 0;
	setMpvTransport(async (line) => answer(line));
}

async function stopPeer(): Promise<void> {
	setMpvTransport();
	await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
	server = null;
}

// ---- the stub player ----
interface Fake extends EventEmitter {
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill(): boolean;
	unref(): void;
}
let player: Fake | null = null;
function stubSpawn(): ChildProcess {
	const c = new EventEmitter() as Fake;
	c.stdout = new EventEmitter();
	c.stderr = new EventEmitter();
	c.kill = () => true;
	c.unref = () => {};
	player = c;
	return c as unknown as ChildProcess;
}

beforeEach(() => {
	notePlayerOutput("");
	setDjSpawn(stubSpawn);
	setDjTools({ mpv: "/stub/mpv", ytdlp: "/stub/yt-dlp" });
	setVolumeStore({ load: () => null, save: () => {} });
	setAudioGraceMs(0);
});
afterEach(async () => {
	new DJ().stop();
	setDjSpawn();
	setDjTools();
	setVolumeStore();
	setAudioGraceMs();
	await stopPeer();
});

async function playing(dj = new DJ()): Promise<DJ> {
	await dj.play("https://example.invalid/track");
	return dj;
}

describe("the deck follows the real player", () => {
	test("a healthy mpv: playing, no trouble, volume and ipc from the player", async () => {
		await startPeer(healthy());
		const s = await (await playing()).status();
		expect(s).toMatchObject({ playing: true, trouble: "", ipc: true, volume: 100 });
	});

	test("a track that failed to load leaves mpv idle: reported with mpv's own reason, not 'playing'", async () => {
		await startPeer({
			...healthy(),
			"idle-active": true,
			"playback-time": null,
			"current-ao": null,
		});
		const dj = new DJ();
		const started = dj.play("https://example.invalid/track");
		// mpv complains while it loads.
		player?.stderr.emit("data", "[ytdl_hook] ERROR: youtube-dl failed: unable to download\n");
		await started;
		const s = await dj.status();
		expect(s.trouble).toBe(
			"could not play: [ytdl_hook] ERROR: youtube-dl failed: unable to download",
		);
	});

	test("a track that simply ended (mpv idle, no complaint) clears the deck", async () => {
		await startPeer({ ...healthy(), "idle-active": true });
		const dj = await playing();
		expect((await dj.status()).playing).toBe(false);
	});

	test("playing with no audio output says 'no sound output' with the reason", async () => {
		await startPeer({ ...healthy(), "current-ao": null });
		const dj = new DJ();
		const started = dj.play("https://example.invalid/track");
		player?.stderr.emit("data", "[ao] Failed to initialize audio driver 'opensles'\n");
		await started;
		const s = await dj.status();
		expect(s.playing).toBe(true);
		expect(s.trouble).toBe("no sound output: [ao] Failed to initialize audio driver 'opensles'");
	});

	test("no audio output and no complaint still says so, in words", async () => {
		await startPeer({ ...healthy(), "current-ao": null });
		const s = await (await playing()).status();
		expect(s.trouble).toContain("no sound output");
		expect(s.trouble).toContain("no audio output");
	});

	test("a silent socket after the grace is trouble, never playing", async () => {
		setMpvTransport(async () => null);
		const s = await (await playing()).status();
		expect(s).toMatchObject({ ipc: false, starting: false, pauseKnown: false });
		expect(s.trouble).toBe("the player is not answering");
	});

	test("a silent socket inside the grace is 'starting', not playing and not yet a fault", async () => {
		setAudioGraceMs(60_000);
		setMpvTransport(async () => null);
		const s = await (await playing()).status();
		expect(s).toMatchObject({ ipc: false, starting: true, pauseKnown: false, trouble: "" });
	});

	test("pause with a silent socket guesses nothing: the state stays unknown", async () => {
		setAudioGraceMs(60_000);
		setMpvTransport(async () => null);
		const dj = await playing();
		expect(await dj.pause()).toContain("state is unknown");
		const s = await dj.status();
		expect(s.pauseKnown).toBe(false);
		// Not flipped to paused by our own toggle.
		expect(s.paused).toBe(false);
	});

	test("the player's pause flag is known once it answers", async () => {
		await startPeer(healthy());
		const dj = await playing();
		expect(await dj.pause()).toBe("Paused.");
		expect(await dj.status()).toMatchObject({ pauseKnown: true, paused: true });
	});
});

describe("volume drives the real player", () => {
	test("dj.volume sets mpv's volume over IPC and reports what mpv now has", async () => {
		await startPeer(healthy());
		const dj = await playing();
		expect(await dj.volume(40)).toBe("Volume: 40%");
		expect(sets).toContainEqual(["volume", 40]);
		expect((await dj.status()).volume).toBe(40);
	});

	test("with no answer from mpv it says the track is unchanged instead of claiming a volume", async () => {
		setMpvTransport(async () => null);
		const dj = await playing();
		expect(await dj.volume(40)).toContain("player did not answer");
	});
});

describe("/dj doctor audio line", () => {
	test("prints ao, volume, mute, paused, idle, time and whether the socket answers", async () => {
		await startPeer(healthy());
		const line = await (await playing()).audioLine();
		expect(line).toContain(
			"Audio: ao=opensles volume=100 mute=no paused=no idle=no time=13s ipc=answers",
		);
		expect(line.split("\n")).toHaveLength(1);
	});

	test("with the socket silent it says so, and carries mpv's last complaint", async () => {
		setMpvTransport(async () => null);
		const dj = new DJ();
		const started = dj.play("https://example.invalid/track");
		player?.stderr.emit("data", "[ao] Failed to initialize audio driver 'opensles'\n");
		await started;
		const line = await dj.audioLine();
		expect(line).toContain("ao=none");
		expect(line).toContain("ipc=silent");
		expect(line).toContain("last error: [ao] Failed to initialize audio driver 'opensles'");
	});

	test("nothing playing says so and still names the start volume", async () => {
		expect(await new DJ().audioLine()).toContain("Audio: nothing playing");
	});
});

describe("the verdict and the player's output", () => {
	const h = (o: Partial<AudioHealth>): AudioHealth => ({
		ipc: true,
		ao: "opensles",
		idle: false,
		time: 5,
		volume: 100,
		mute: false,
		paused: false,
		...o,
	});
	test("table", () => {
		setAudioGraceMs(3000);
		expect(diagnoseAudio(h({}), 10_000, undefined)).toEqual({ ok: true });
		// No answer is never ok: starting inside the grace, then the player is not answering.
		expect(diagnoseAudio(h({ ipc: false }), 1000, undefined)).toMatchObject({ kind: "starting" });
		expect(diagnoseAudio(h({ ipc: false }), 10_000, "x")).toEqual({
			ok: false,
			kind: "silent",
			reason: "the player is not answering",
		});
		expect(diagnoseAudio(h({ idle: true }), 1000, "x")).toEqual({ ok: true }); // still loading
		expect(diagnoseAudio(h({ idle: true }), 10_000, "boom")).toEqual({
			ok: false,
			kind: "failed",
			reason: "boom",
		});
		expect(diagnoseAudio(h({ idle: true }), 10_000, undefined)).toMatchObject({ kind: "ended" });
		expect(diagnoseAudio(h({ ao: null }), 10_000, undefined)).toMatchObject({ kind: "no-output" });
		// Not started yet: no time, no ao is just "loading".
		expect(diagnoseAudio(h({ ao: null, time: null }), 10_000, undefined)).toEqual({ ok: true });
	});

	test("only complaints are kept; mpv's chatter is dropped", async () => {
		await startPeer({ ...healthy(), "idle-active": true });
		const dj = new DJ();
		const started = dj.play("https://example.invalid/track");
		player?.stdout.emit(
			"data",
			"AO: [opensles] 44100Hz stereo 2ch float\nA: 00:00:03 / 00:03:20\n",
		);
		player?.stderr.emit("data", "[cplayer] Failed to open https://example.invalid/track.\n");
		await started;
		expect((await dj.status()).trouble).toBe(
			"could not play: [cplayer] Failed to open https://example.invalid/track.",
		);
	});

	test("mpv's output pipes are unref'd so they cannot keep the process alive", async () => {
		const calls: string[] = [];
		setDjSpawn(() => {
			const c = stubSpawn() as unknown as Fake;
			(c.stdout as unknown as { unref: () => void }).unref = () => calls.push("stdout");
			(c.stderr as unknown as { unref: () => void }).unref = () => calls.push("stderr");
			return c as unknown as ChildProcess;
		});
		await startPeer(healthy());
		await playing();
		expect(calls.sort()).toEqual(["stderr", "stdout"]);
	});

	test("mpv is started with errors only and no status line", () => {
		expect(mpvStartArgs(100, ["x"])).toEqual([
			"--volume=100",
			"--msg-level=all=warn",
			"--term-status-msg=",
			"x",
		]);
	});
});

describe("over a real unix socket", () => {
	/** Binding a socket can be forbidden (a sandbox); then this proves nothing and says so. */
	async function canBind(): Promise<boolean> {
		const path = mpvIpcPath();
		mkdirSync(dirname(path), { recursive: true });
		rmSync(path, { force: true });
		return await new Promise<boolean>((resolve) => {
			const t = net.createServer();
			t.on("error", () => resolve(false));
			t.listen(path, () => t.close(() => resolve(true)));
		});
	}

	test("the DJ's own client reads volume and ao from a peer on its socket path", async () => {
		if (!(await canBind())) {
			console.log("skipped: this environment forbids binding a unix socket");
			return;
		}
		props = healthy();
		const path = mpvIpcPath();
		rmSync(path, { force: true });
		server = net.createServer((sock) => {
			sock.on("data", (d) => {
				for (const line of d.toString().split("\n")) if (line.trim()) sock.write(answer(line));
			});
		});
		await new Promise<void>((r) => server?.listen(path, () => r()));
		const dj = await playing();
		expect(await dj.audioLine()).toContain("ao=opensles volume=100");
		expect((await dj.status()).trouble).toBe("");
	});
});
