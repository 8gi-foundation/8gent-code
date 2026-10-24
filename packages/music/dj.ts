/**
 * DJ - Eight's streaming, radio, and YouTube playback system.
 *
 * Inspired by pi-dj (https://github.com/arosstale/pi-dj).
 * Rebuilt for 8gent's architecture using mpv + yt-dlp + ffmpeg.
 *
 * Capabilities:
 * - YouTube search and streaming via mpv + yt-dlp
 * - Global internet radio (Radio Browser API - 30k+ stations)
 * - Suno AI music generation
 * - SoundCloud / Bandcamp downloads
 * - Playback control (pause, skip, volume, queue, repeat, now playing)
 * - BPM detection
 * - Crossfade mixing
 * - Resume across sessions
 */

import { type ChildProcess, type SpawnOptions, execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import * as net from "node:net";
import { homedir, platform, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, sep, win32 } from "node:path";
import { getSettingsFilePath, loadSettings } from "../settings/store.js";
import { isAndroidHost } from "../voice/termux.js";
import { type KeyJob, detectKey } from "./key-detect.js";
import { stopOwnPlayers } from "./player.js";
import { type TrackInfo, trackInfoFromMetadata } from "./track-info.js";

// ---- Process and preference seams (tests swap these) ----
type Spawn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
let spawnImpl: Spawn = spawn;

/** Tests swap the spawner for mpv and the yt-dlp search; call with nothing to restore it. */
export function setDjSpawn(fn?: Spawn): void {
	spawnImpl = fn ?? spawn;
}

/** Where the DJ keeps the listener's volume between tracks and sessions (#3190). */
export interface VolumeStore {
	load(): number | null;
	save(v: number): void;
}

/** The volume a first-ever track starts at: audible, well short of loud. */
export const DEFAULT_VOLUME = 60;

/**
 * mpv's volume is a cubic gain: 60 is -13.3 dB, 100 is the track as it was
 * mastered. A laptop has hardware headroom to give that back; a phone's media
 * stream and speaker do not (#4907), so on Termux a first-ever track starts at
 * unity. A volume the listener chose is theirs and wins on every platform.
 */
export const TERMUX_DEFAULT_VOLUME = 100;

/** The volume a first-ever track starts at on this host. */
export function defaultVolume(termux: boolean = isAndroidHost()): number {
	return termux ? TERMUX_DEFAULT_VOLUME : DEFAULT_VOLUME;
}

const settingsVolumeStore: VolumeStore = {
	load() {
		const v = loadSettings().music?.volume;
		return typeof v === "number" && Number.isFinite(v) ? v : null;
	},
	save(v) {
		writeVolumeSetting(getSettingsFilePath(), v);
	},
};

/**
 * Set music.volume in a settings file and change nothing else in it.
 * setSetting is not used: it writes the file back through the typed
 * defaults, which drops every key they do not know (briefings, connectors).
 * A file that is not a JSON object is left alone.
 */
export function writeVolumeSetting(file: string, v: number): void {
	let raw: Record<string, unknown> = {};
	if (existsSync(file)) {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
		raw = parsed as Record<string, unknown>;
	}
	const music = raw.music && typeof raw.music === "object" ? raw.music : {};
	raw.music = { ...music, volume: v };
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
	renameSync(tmp, file);
}
let volumeStore: VolumeStore = settingsVolumeStore;

/** Tests swap the store for one in memory; call with nothing to restore ~/.8gent/settings.json. */
export function setVolumeStore(store?: VolumeStore): void {
	volumeStore = store ?? settingsVolumeStore;
}

/** mpv takes 0-150; anything else, or nothing stored, is the default. */
export function clampVolume(v: unknown): number {
	const n = typeof v === "number" ? v : Number.NaN;
	return Number.isFinite(n) ? Math.round(Math.max(0, Math.min(150, n))) : DEFAULT_VOLUME;
}

/** The volume the next track starts at. */
export function preferredVolume(): number {
	const fallback = defaultVolume();
	try {
		return clampVolume(volumeStore.load() ?? fallback);
	} catch {
		return fallback;
	}
}

/** Every argument mpv starts with: the volume first, then what the caller names. */
export function mpvStartArgs(volume: number, args: string[]): string[] {
	// Errors only, and no status line: what mpv says when it cannot load a track or
	// open an audio device is read back for the deck and /dj doctor (#4907).
	return [`--volume=${volume}`, "--msg-level=all=warn", "--term-status-msg=", ...args];
}

/**
 * Remember a chosen volume. Mute (0) is not a preference: a muted track
 * must not make every later track and session start silent.
 */
function rememberVolume(v: number): void {
	if (v <= 0) return;
	try {
		volumeStore.save(clampVolume(v));
	} catch {}
}

/**
 * Search YouTube for one result, off the event loop (#3182). Resolves null
 * when nothing is found, yt-dlp fails, or the search runs past `timeoutMs`
 * (the child is then ended by its own handle).
 */
export function ytSearch(
	ytdlp: string,
	query: string,
	timeoutMs = 15000,
): Promise<{ title: string; url: string } | null> {
	return new Promise((resolve) => {
		let out = "";
		let child: ChildProcess;
		try {
			child = spawnImpl(ytdlp, ["--print", "%(title)s\t%(webpage_url)s", `ytsearch1:${query}`], {
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			});
		} catch {
			resolve(null);
			return;
		}
		let done = false;
		const finish = (v: { title: string; url: string } | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(v);
		};
		const timer = setTimeout(() => {
			try {
				child.kill("SIGTERM");
			} catch {}
			finish(null);
		}, timeoutMs);
		child.stdout?.on("data", (d) => {
			out += d;
		});
		child.on("error", () => finish(null));
		child.on("close", (code) => {
			const [title, url] = out.trim().split("\n")[0]?.split("\t") ?? [];
			finish(code === 0 && url ? { title: title || query, url: url.trim() } : null);
		});
	});
}

// ---- Platform ----
const PLATFORM = platform();
const HOME = homedir();

/** The folder of local beds. A direct file path plays only from inside it (#4530). */
export function bedsDir(): string {
	return process.env.EIGHT_BEDS_DIR || join(HOME, ".8gent", "creative", "music", "beds");
}

/** True when `file` exists and its realpath (symlinks resolved) is inside the beds folder. */
export function isBedPath(file: string): boolean {
	try {
		const root = realpathSync(bedsDir());
		const real = realpathSync(file);
		return real.startsWith(root.endsWith(sep) ? root : root + sep);
	} catch {
		return false;
	}
}
const TMP = tmpdir();

/**
 * mpv's IPC endpoint: a named pipe on Windows, a unix socket elsewhere. Keyed by
 * pid so two 8gent sessions never take over each other's player.
 */
export function mpvIpcPath(
	plat: NodeJS.Platform = PLATFORM,
	tmp: string = TMP,
	pid: number = process.pid,
): string {
	const name = `mpv-8gent-dj-${pid}`;
	// Join with the separator of the platform named by `plat`, not the host's:
	// node:path's join() is host-relative, so on Windows it would emit
	// backslashes into a unix socket path.
	const pathOf = plat === "win32" ? win32 : posix;
	return plat === "win32" ? `\\\\.\\pipe\\${name}` : pathOf.join(tmp, `${name}.sock`);
}

/** The one-line install hint for the DJ's tools on this platform. */
export function installHint(plat: NodeJS.Platform = PLATFORM): string {
	if (plat === "win32") return "scoop bucket add extras; scoop install mpv yt-dlp ffmpeg sox";
	if (plat === "android") return "pkg install mpv python-yt-dlp ffmpeg";
	if (plat === "linux") return "sudo apt install mpv yt-dlp ffmpeg sox";
	return "brew install mpv yt-dlp ffmpeg sox";
}

/** The tools /dj cannot play without, in the order they are installed. sox is optional. */
export const REQUIRED_TOOLS = ["mpv", "yt-dlp", "ffmpeg"] as const;

/** What the install runs: the command to show, and the one to spawn (null when 8gent must not run it). */
export interface InstallPlan {
	display: string;
	run: { cmd: string; args: string[] } | null;
}

/** Termux ships yt-dlp as python-yt-dlp (it declares PROVIDES yt-dlp); elsewhere the name is the tool. */
function packageFor(tool: string, plat: NodeJS.Platform): string {
	return plat === "android" && tool === "yt-dlp" ? "python-yt-dlp" : tool;
}

/**
 * The install for the missing tools. Termux and macOS (with brew on PATH) are
 * run in place; Linux and Windows only show the command, because they need
 * sudo or a bucket and 8gent never runs sudo.
 */
export function installPlan(
	missing: readonly string[],
	plat: NodeJS.Platform = PLATFORM,
	hasBrew = true,
): InstallPlan {
	const pkgs = missing.map((t) => packageFor(t, plat));
	if (plat === "android")
		return {
			display: `pkg install -y ${pkgs.join(" ")}`,
			run: { cmd: "pkg", args: ["install", "-y", ...pkgs] },
		};
	if (plat === "linux") return { display: `sudo apt install ${pkgs.join(" ")}`, run: null };
	if (plat === "win32") return { display: `scoop install ${pkgs.join(" ")}`, run: null };
	return {
		display: `brew install ${pkgs.join(" ")}`,
		run: hasBrew ? { cmd: "brew", args: ["install", ...pkgs] } : null,
	};
}

/** The last readable line of installer output, for the one status line. */
export function lastProgressLine(chunk: string): string | null {
	const clean = chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "\n");
	const line = clean
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.pop();
	return line ? line.slice(0, 100) : null;
}

/** How to look up a command on PATH without a POSIX shell: where.exe on Windows. */
export function whichCommand(cmd: string, plat: NodeJS.Platform = PLATFORM): [string, string[]] {
	return plat === "win32"
		? ["where.exe", [cmd]]
		: ["/bin/sh", ["-c", 'command -v "$1"', "sh", cmd]];
}

/**
 * The first usable path from a PATH lookup. where.exe lists every match, and a
 * .cmd or .bat shim cannot be spawned without a shell, so prefer .exe or .com.
 */
export function pickResolved(out: string): string | null {
	const lines = out
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	return lines.find((l) => /\.(exe|com)$/i.test(l)) ?? lines[0] ?? null;
}

const IPC_PATH = mpvIpcPath();
const MUSIC_DIR = join(HOME, "Music", "8gent");
const RESUME_PATH = join(HOME, ".8gent", "dj-resume.json");

// ---- Tool Detection ----
type Which = (cmd: string) => string | null;
let whichImpl: Which | null = null;

/** Tests name where tools are found instead of looking on PATH; call with nothing to restore it. */
export function setDjWhich(fn?: Which): void {
	whichImpl = fn ?? null;
}

function which(cmd: string): string | null {
	if (whichImpl) return whichImpl(cmd);
	try {
		const [bin, args] = whichCommand(cmd);
		const out = execFileSync(bin, args, {
			encoding: "utf-8",
			timeout: 3000,
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		return pickResolved(out);
	} catch {
		return null;
	}
}

interface Tools {
	mpv: string | null;
	ytdlp: string | null;
	ffmpeg: string | null;
	sox: string | null;
}

let tools: Tools | null = null;

/** Tests name the tools instead of looking on PATH; call with nothing to look again. */
export function setDjTools(t?: Partial<Tools>): void {
	tools = t ? { mpv: null, ytdlp: null, ffmpeg: null, sox: null, ...t } : null;
}

function detectTools(): Tools {
	if (tools) return tools;
	tools = {
		mpv: which("mpv"),
		ytdlp: which("yt-dlp"),
		ffmpeg: which("ffmpeg"),
		sox: which("sox"),
	};
	return tools;
}

// ---- mpv IPC ----
let ipcReady = false;

/** A stand-in for the socket: gets the command line, returns mpv's raw reply text, or null for silence. */
type MpvTransport = (line: string) => Promise<string | null>;
let transportImpl: MpvTransport | null = null;

/** Tests swap the socket for a fake mpv peer; call with nothing to restore it. */
export function setMpvTransport(fn?: MpvTransport): void {
	transportImpl = fn ?? null;
}

function mpvIpc(cmd: Record<string, any>): Promise<any> {
	if (!ipcReady) return Promise.resolve(null);
	const line = `${JSON.stringify(cmd)}\n`;
	if (transportImpl)
		return transportImpl(line).then((raw) => (raw == null ? null : parseMpvReply(raw).data));
	return typeof Bun !== "undefined" ? mpvIpcBun(line) : mpvIpcNode(line);
}

/**
 * Bun's node:net client stops delivering mpv's replies once a stream is
 * playing (seen on Bun 1.3.14: every query timed out, so the HUD sat at
 * 0:00 / 0:00). Bun.connect keeps receiving them, so use it under Bun.
 */
function mpvIpcBun(line: string): Promise<any> {
	return new Promise((resolve) => {
		let buf = "";
		let done = false;
		let sock: { end(): void } | null = null;
		const finish = (v: any) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				sock?.end();
			} catch {}
			resolve(v);
		};
		const timer = setTimeout(() => finish(null), 1500);
		Bun.connect({
			unix: IPC_PATH,
			socket: {
				data(_s, d) {
					buf += d.toString();
					const reply = parseMpvReply(buf);
					if (reply.complete) finish(reply.data);
				},
				error() {
					finish(null);
				},
				close() {
					finish(parseMpvReply(buf).data);
				},
			},
		})
			.then((s) => {
				sock = s;
				if (done) s.end();
				else s.write(line);
			})
			.catch(() => finish(null));
	});
}

function mpvIpcNode(line: string): Promise<any> {
	return new Promise((resolve) => {
		const client = net.createConnection(IPC_PATH);
		let buf = "";
		let done = false;
		const finish = (v: any) => {
			if (done) return;
			done = true;
			client.destroy();
			resolve(v);
		};
		client.setTimeout(1500);
		client.on("connect", () => client.write(line));
		// mpv keeps the connection open, so answer as soon as the reply line arrives
		// instead of waiting for a close that never comes.
		client.on("data", (d) => {
			buf += d;
			const reply = parseMpvReply(buf);
			if (reply.complete) finish(reply.data);
		});
		client.on("timeout", () => finish(null));
		client.on("error", () => finish(null));
		client.on("close", () => finish(parseMpvReply(buf).data));
	});
}

/**
 * Find mpv's reply in the IPC stream. mpv interleaves event lines
 * ({"event": ...}) with the reply, which is the line carrying an "error" field.
 */
export function parseMpvReply(buf: string): { complete: boolean; data: any } {
	for (const line of buf.split("\n")) {
		if (!line.trim()) continue;
		try {
			const msg = JSON.parse(line);
			if (msg && typeof msg === "object" && "error" in msg) {
				return { complete: true, data: msg.error === "success" ? (msg.data ?? null) : null };
			}
		} catch {
			// partial line; wait for more data
		}
	}
	return { complete: false, data: null };
}

const mpvGet = (p: string) =>
	mpvIpc({ command: ["get_property", p] }).then((v) => (v != null ? String(v) : null));
const mpvSet = (p: string, v: any) => mpvIpc({ command: ["set_property", p, v] });

// ---- What the real player says (#4907) ----
const EMPTY_STATUS = {
	ipc: false,
	trouble: "",
	playing: false,
	paused: false,
	looping: false,
	title: "",
	url: "",
	position: null,
	duration: null,
	volume: null,
	queueSize: 0,
	name: "",
	artists: [] as string[],
	keyLabel: "",
};

/** The last few things mpv complained about (a failed load, no audio device), newest last. */
let playerErrors: string[] = [];
const ERROR_LINE =
	/error|fail|could not|cannot|can't|unable|no such|not found|refus|denied|ytdl|yt-dlp|youtube-dl/i;

/** Keep mpv's complaints; its chatter is dropped. */
export function notePlayerOutput(chunk: unknown): void {
	for (const raw of String(chunk).split(/[\r\n]+/)) {
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
		const line = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
		if (line && ERROR_LINE.test(line))
			playerErrors = [...playerErrors, line.slice(0, 160)].slice(-4);
	}
}

export interface AudioHealth {
	/** mpv answered on its control socket. */
	ipc: boolean;
	/** mpv's audio output (opensles, coreaudio...), or null when it has none. */
	ao: string | null;
	/** mpv has nothing loaded: the track failed to load or has ended. */
	idle: boolean;
	/** Seconds into the track, or null before it starts. */
	time: number | null;
	volume: number | null;
	mute: boolean | null;
	paused: boolean | null;
}

/** Ask mpv, over its own socket, what it is doing. Every field is the player's answer, never ours. */
export async function readAudioHealth(): Promise<AudioHealth> {
	const [ver, idle, ao, time, vol, mute, pause] = await Promise.all([
		mpvGet("mpv-version"),
		mpvGet("idle-active"),
		mpvGet("current-ao"),
		mpvGet("playback-time"),
		mpvGet("volume"),
		mpvGet("mute"),
		mpvGet("pause"),
	]);
	const t = time == null ? Number.NaN : Number.parseFloat(time);
	const v = vol == null ? Number.NaN : Number.parseFloat(vol);
	return {
		ipc: ver != null,
		ao,
		idle: idle === "true",
		time: Number.isFinite(t) ? t : null,
		volume: Number.isFinite(v) ? v : null,
		mute: mute == null ? null : mute === "true",
		paused: pause == null ? null : pause === "true",
	};
}

export type AudioVerdict =
	| { ok: true }
	| { ok: false; kind: "failed" | "ended" | "no-output"; reason: string };

/** Startup grace: mpv is still loading the stream and opening the device. */
let AUDIO_GRACE_MS = 3000;
/** Tests shorten the grace; call with nothing to restore it. */
export function setAudioGraceMs(ms?: number): void {
	AUDIO_GRACE_MS = ms ?? 3000;
}

/**
 * Whether sound can be coming out, from the player's own answers. If mpv does not
 * answer at all this says ok: it cannot tell, and does not claim a fault it did not see.
 */
export function diagnoseAudio(
	h: AudioHealth,
	sinceStartMs: number,
	lastError: string | undefined,
): AudioVerdict {
	if (!h.ipc || sinceStartMs < AUDIO_GRACE_MS) return { ok: true };
	if (h.idle)
		return lastError
			? { ok: false, kind: "failed", reason: lastError }
			: { ok: false, kind: "ended", reason: "the track ended" };
	if (h.time != null && h.ao == null)
		return {
			ok: false,
			kind: "no-output",
			reason: lastError ?? "mpv found no audio output on this phone",
		};
	return { ok: true };
}

// ---- Playback State ----
let mpvProcess: ChildProcess | null = null;
/** mpv children that have ended, so a start can tell "never came up" from "still starting". */
const exited = new WeakSet<ChildProcess>();
/** Bumped by every play, radio and stop; a slower one that finds it moved on gives way. */
let playGen = 0;
let currentTrack = { title: "", url: "" };
let isPlaying = false;
let isPaused = false;
/**
 * The DJ's own stopwatch for the current track: when it started and how long it
 * sat paused. The clock falls back to it when mpv's IPC does not answer (a
 * Termux socket can fail), so the deck still moves, from the process we spawned (#4907).
 */
let clock = { startedAt: 0, pausedMs: 0, pausedAt: 0 };
const startClock = () => {
	clock = { startedAt: Date.now(), pausedMs: 0, pausedAt: 0 };
};
const clockPause = (paused: boolean) => {
	if (paused && !clock.pausedAt) clock.pausedAt = Date.now();
	if (!paused && clock.pausedAt) {
		clock.pausedMs += Date.now() - clock.pausedAt;
		clock.pausedAt = 0;
	}
};
const clockSeconds = () =>
	Math.max(0, ((clock.pausedAt || Date.now()) - clock.startedAt - clock.pausedMs) / 1000);
let isLooping = false;
let trackQueue: { title: string; url: string }[] = [];
/** How the current source reaches mpv: through yt-dlp (a web page) or as a direct stream/file. */
let sourceKind: "ytdl" | "direct" = "direct";

// ---- Track info and key (#3192) ----
export interface KeyState {
	state: "tag" | "detecting" | "estimated" | "unknown";
	key: string | null;
}

/** The deck's and np's wording for a key state. Never a key the source or the audio did not give. */
export function keyLabel(k: KeyState | undefined | null): string {
	if (!k) return "";
	if (k.state === "tag") return `Key: ${k.key}`;
	if (k.state === "estimated") return `Key: ${k.key} (est.)`;
	if (k.state === "detecting") return "Key: detecting...";
	return "Key: unknown";
}

const EMPTY_INFO: TrackInfo = { name: "", artists: [], keyTag: null };
/** url|icy-title the info below was read for, whether the metadata had arrived, and the key's id. */
let infoSig = "";
let infoLoaded = false;
let infoKeyId = "";
let info: TrackInfo = EMPTY_INFO;
const keyCache = new Map<string, KeyState>();
let keyJob: KeyJob | null = null;
/** Seconds of playback before the key estimate starts its own download. */
const KEY_START_AFTER_SEC = 3;
/** A key shown as detecting while it waits for playback to start. */
let keyPending = "";
/** Bumped whenever estimates are abandoned; a finishing estimate from an older generation is dropped. */
let keyGen = 0;

/** yt-dlp resolves a page to a direct audio URL, off the event loop. */
function resolveAudioUrl(ytdlp: string, url: string): Promise<string | null> {
	return new Promise((resolve) => {
		let out = "";
		let child: ChildProcess;
		try {
			child = spawn(ytdlp, ["-f", "bestaudio", "-g", "--no-playlist", url], {
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			});
		} catch {
			resolve(null);
			return;
		}
		const timer = setTimeout(() => {
			try {
				child.kill("SIGTERM");
			} catch {}
		}, 20000);
		child.stdout?.on("data", (d) => {
			out += d;
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve(null);
		});
		child.on("close", () => {
			clearTimeout(timer);
			resolve(out.split(/\r?\n/).find((l) => l.startsWith("http")) ?? null);
		});
	});
}

/** Stop the running estimate and forget unfinished ones, so a cut-short sample never names a key. */
function abandonDetections(): void {
	keyGen++;
	keyJob?.cancel();
	keyJob = null;
	for (const [id, k] of keyCache) if (k.state === "detecting") keyCache.delete(id);
}

/** A live stream: a direct source with no finite length. A yt-dlp page is always a track. */
function isLive(duration: number | null): boolean {
	return (
		sourceKind === "direct" && !(duration != null && Number.isFinite(duration) && duration > 0)
	);
}

/** The id a key belongs to: the source for a track, source + song for a live stream whose songs change. */
function keyId(url: string, song: string, live: boolean): string {
	return live ? `${url}|${song}` : url;
}

/** Start one local key estimate for the playing source, unless one is known or running. */
function ensureKey(id: string, url: string, duration: number | null): void {
	if (keyCache.has(id)) return;
	const t = detectTools();
	if (!t.ffmpeg || (sourceKind === "ytdl" && !t.ytdlp)) {
		keyCache.set(id, { state: "unknown", key: null });
		return;
	}
	abandonDetections();
	keyCache.set(id, { state: "detecting", key: null });
	// A track: 20 s from a quarter in (past any intro), capped at a minute; 30 s in
	// while its length is not known yet. A live stream: from now.
	const known = duration != null && Number.isFinite(duration) && duration > 0;
	const offsetSec = isLive(duration) ? 0 : known ? Math.min(60, Math.floor(duration * 0.25)) : 30;
	const ffmpeg = t.ffmpeg;
	const gen = keyGen;
	const stillWanted = () => gen === keyGen && keyCache.get(id)?.state === "detecting";
	const kind = sourceKind;
	(async () => {
		// Two tries: a freshly resolved media URL now and then refuses its first read.
		let est = null;
		for (let attempt = 0; attempt < 2 && !est; attempt++) {
			const src = kind === "ytdl" ? await resolveAudioUrl(t.ytdlp!, url) : url;
			if (!stillWanted()) return;
			if (!src) continue;
			const job = detectKey(src, { ffmpeg, offsetSec, seconds: 20, timeoutMs: 30000 });
			keyJob = job;
			est = await job.promise;
			if (!stillWanted()) return;
			keyJob = null;
		}
		keyCache.set(id, est ? { state: "estimated", key: est.key } : { state: "unknown", key: null });
	})().catch(() => {
		if (stillWanted()) keyCache.set(id, { state: "unknown", key: null });
	});
}

/**
 * Refresh the track info while something plays. mpv's media-title is the
 * --title the DJ passed, so it never changes; what changes is the metadata
 * (it arrives a moment after load) and, on radio, icy-title per song. The
 * full metadata map is read until it has arrived and again on each new song;
 * otherwise a poll costs one small IPC on radio and none on a track.
 */
async function refreshTrackInfo(duration: number | null, position: number | null): Promise<void> {
	if (!currentTrack.url) return;
	const icy = sourceKind === "direct" ? ((await mpvGet("metadata/by-key/icy-title")) ?? "") : "";
	const sig = `${currentTrack.url}|${icy}`;
	if (sig !== infoSig || !infoLoaded) {
		const meta = await mpvIpc({ command: ["get_property", "metadata"] });
		const loaded = !!meta && typeof meta === "object" && Object.keys(meta).length > 0;
		info = trackInfoFromMetadata(loaded ? meta : null, currentTrack.title);
		infoSig = sig;
		infoLoaded = loaded;
		// A track's key waits for its metadata (it may carry a key tag).
		if (!loaded && sourceKind === "ytdl") return;
	}
	const id = keyId(currentTrack.url, icy, isLive(duration));
	infoKeyId = id;
	if (info.keyTag) {
		keyCache.set(id, { state: "tag", key: info.keyTag });
		return;
	}
	// The estimate downloads its own sample; starting it while mpv is still
	// buffering the same track competes with playback. Wait for sound.
	if (!keyCache.has(id) && (position ?? 0) < KEY_START_AFTER_SEC) {
		keyCache.set(id, { state: "detecting", key: null });
		keyPending = id;
		return;
	}
	if (keyPending === id) {
		keyPending = "";
		keyCache.delete(id);
	}
	ensureKey(id, currentTrack.url, duration);
}

function currentKey(): KeyState | null {
	return infoKeyId ? (keyCache.get(infoKeyId) ?? null) : null;
}
const history: { title: string; url: string; playedAt: number }[] = [];

// ---- Resume State ----
interface ResumeState {
	title: string;
	url: string;
	positionSec: number;
	timestamp: number;
}

function saveResume(title: string, url: string, positionSec: number): void {
	try {
		mkdirSync(join(HOME, ".8gent"), { recursive: true });
		writeFileSync(RESUME_PATH, JSON.stringify({ title, url, positionSec, timestamp: Date.now() }));
	} catch {}
}

function loadResume(): ResumeState | null {
	try {
		const data = JSON.parse(readFileSync(RESUME_PATH, "utf-8"));
		if (data.url && Date.now() - data.timestamp < 86400000) return data;
	} catch {}
	return null;
}

// ---- Radio Browser API ----
const RADIO_API = "https://de1.api.radio-browser.info/json";
const RADIO_PRESETS: Record<string, string> = {
	lofi: "lo-fi",
	chill: "chillout",
	jazz: "jazz",
	classical: "classical",
	rock: "rock",
	metal: "metal",
	edm: "electronic",
	techno: "techno",
	house: "house",
	dnb: "drum and bass",
	hiphop: "hip hop",
	ambient: "ambient",
	funk: "funk",
	soul: "soul",
	reggae: "reggae",
	blues: "blues",
	punk: "punk",
	pop: "pop",
	country: "country",
	rnb: "rnb",
	rap: "rap",
};

// ---- Main DJ Class ----
export class DJ {
	constructor() {
		detectTools();
		mkdirSync(MUSIC_DIR, { recursive: true });
	}

	/** Check what tools are available */
	doctor(): {
		mpv: boolean;
		ytdlp: boolean;
		ffmpeg: boolean;
		sox: boolean;
		installCmd: string;
	} {
		const t = detectTools();
		return {
			mpv: !!t.mpv,
			ytdlp: !!t.ytdlp,
			ffmpeg: !!t.ffmpeg,
			sox: !!t.sox,
			installCmd: installHint(),
		};
	}

	/**
	 * One line to paste when there is no sound: the audio output, volume, mute, whether
	 * mpv answers on its control socket, and the last thing it complained about.
	 */
	async audioLine(): Promise<string> {
		const host = isAndroidHost() ? "termux" : platform();
		if (!isPlaying) {
			return `Audio: nothing playing | host=${host} start-volume=${preferredVolume()} mpv=${detectTools().mpv ? "found" : "missing"}${playerErrors.length ? ` | last error: ${playerErrors.at(-1)}` : ""}`;
		}
		const h = await readAudioHealth();
		const yn = (b: boolean | null) => (b == null ? "?" : b ? "yes" : "no");
		const err = playerErrors.at(-1);
		return (
			[
				`Audio: ao=${h.ao ?? "none"}`,
				`volume=${h.volume ?? "?"}`,
				`mute=${yn(h.mute)}`,
				`paused=${yn(h.paused)}`,
				`idle=${yn(h.ipc ? h.idle : null)}`,
				`time=${h.time == null ? "?" : Math.round(h.time)}s`,
				`ipc=${h.ipc ? "answers" : "silent"}`,
				`host=${host}`,
			].join(" ") + (err ? ` | last error: ${err}` : "")
		);
	}

	/** The required tools that are not on PATH right now. */
	missingTools(): string[] {
		const t = detectTools();
		const have: Record<string, string | null> = { mpv: t.mpv, "yt-dlp": t.ytdlp, ffmpeg: t.ffmpeg };
		return REQUIRED_TOOLS.filter((n) => !have[n]);
	}

	/**
	 * Offer to install what is missing, with one yes (#4810). Asks once; on yes
	 * runs the platform install, reports its last line as progress, looks for the
	 * tools again, and says whether the DJ can play. On no, or where 8gent must
	 * not run the command, it shows the command and changes nothing. Nothing runs
	 * without the yes.
	 */
	async ensureTools(io: {
		ask: (question: string) => Promise<boolean>;
		say: (line: string) => void;
		progress?: (line: string) => void;
		plat?: NodeJS.Platform;
	}): Promise<"none" | "declined" | "manual" | "installed" | "failed"> {
		const missing = this.missingTools();
		if (missing.length === 0) return "none";
		const plat = io.plat ?? PLATFORM;
		const plan = installPlan(missing, plat, !!which("brew"));
		if (!plan.run) {
			io.say(`${missing.join(", ")} not installed. Run: ${plan.display}`);
			return "manual";
		}
		const yes = await io.ask(
			`${missing.join(", ")} not installed. Install now with \`${plan.display}\`? (y / Enter = yes, anything else = no)`,
		);
		if (!yes) {
			io.say(`Not installed. Run: ${plan.display}`);
			return "declined";
		}
		const code = await new Promise<number | null>((resolve) => {
			let settled = false;
			const done = (c: number | null) => {
				if (!settled) {
					settled = true;
					resolve(c);
				}
			};
			try {
				const child = spawnImpl(plan.run!.cmd, plan.run!.args, {
					stdio: ["ignore", "pipe", "pipe"],
				});
				const onData = (d: unknown) => {
					const line = lastProgressLine(String(d));
					if (line) io.progress?.(line);
				};
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				child.on("error", () => done(null));
				child.on("close", (c) => done(c));
			} catch {
				done(null);
			}
		});
		tools = null; // look again: the install changed what is on PATH
		const still = this.missingTools();
		if (code === 0 && still.length === 0) {
			io.say("Installed. mpv, yt-dlp and ffmpeg are ready.");
			return "installed";
		}
		const why =
			code === 0
				? `still missing: ${still.join(", ")}`
				: `install exited ${code ?? "without starting"}`;
		io.say(`Install did not finish (${why}). Run it yourself: ${plan.display}`);
		return "failed";
	}

	/** Play a YouTube video/song by query or URL */
	async play(queryOrUrl: string): Promise<string> {
		const t = detectTools();
		if (!t.mpv) return `mpv not installed. Run: ${installHint()}`;
		// A URL or a file inside the beds folder plays as is; anything else is a search.
		// An absolute path outside the beds folder is refused, never searched or played,
		// so chat text cannot play or probe an arbitrary local file.
		if (isAbsolute(queryOrUrl) && !isBedPath(queryOrUrl))
			return "Refused: only files in the beds folder play directly.";
		const direct = queryOrUrl.startsWith("http") || isAbsolute(queryOrUrl);
		if (!t.ytdlp && !direct) return `yt-dlp not installed. Run: ${installHint()}`;

		let url = queryOrUrl;
		let title = direct && !queryOrUrl.startsWith("http") ? basename(queryOrUrl) : queryOrUrl;
		// A stop or a newer play while this one searches wins (#3182).
		const gen = ++playGen;

		// If not a URL, search YouTube, off the event loop so the TUI keeps drawing.
		if (!direct) {
			const found = await ytSearch(t.ytdlp!, queryOrUrl);
			if (gen !== playGen) return "Stopped.";
			if (!found) return `No results found for: ${queryOrUrl}`;
			title = found.title;
			url = found.url;
		}

		this.killMpv();

		const child = this.spawnMpv(t.mpv, [
			"--no-video",
			"--idle=yes",
			`--input-ipc-server=${IPC_PATH}`,
			`--title=${title}`,
			url,
		]);
		mpvProcess = child;

		// Wait for IPC socket
		await new Promise((r) => setTimeout(r, 1500));
		if (gen !== playGen) return "Stopped.";
		if (exited.has(child)) return `Could not play: mpv exited right away. Run /dj doctor.`;
		ipcReady = true;

		currentTrack = { title, url };
		sourceKind = "ytdl";
		isPlaying = true;
		isPaused = false;
		startClock();
		history.push({ title, url, playedAt: Date.now() });

		return `Now playing: ${title}`;
	}

	/** Play internet radio by genre or station name */
	async radio(query: string): Promise<string> {
		const t = detectTools();
		if (!t.mpv) return `mpv not installed. Run: ${installHint()}`;

		// Direct URL
		if (query.startsWith("http")) {
			this.killMpv();
			const gen = ++playGen;
			const child = this.spawnMpv(t.mpv, ["--no-video", `--input-ipc-server=${IPC_PATH}`, query]);
			mpvProcess = child;
			await new Promise((r) => setTimeout(r, 1500));
			if (gen !== playGen) return "Stopped.";
			if (exited.has(child)) return `Could not play: mpv exited right away. Run /dj doctor.`;
			ipcReady = true;
			isPlaying = true;
			startClock();
			sourceKind = "direct";
			currentTrack = { title: `Radio: ${query}`, url: query };
			return `Radio streaming: ${query}`;
		}

		// Preset or search
		const searchTerm = RADIO_PRESETS[query.toLowerCase()] || query;

		const gen = ++playGen;
		try {
			const res = await fetch(
				`${RADIO_API}/stations/search?name=${encodeURIComponent(searchTerm)}&limit=5&order=votes&reverse=true`,
			);
			const stations = (await res.json()) as any[];

			if (gen !== playGen) return "Stopped.";
			if (!stations || stations.length === 0) return `No radio stations found for: ${query}`;

			const station = stations[0];
			const streamUrl = station.url_resolved || station.url;

			this.killMpv();
			const child = this.spawnMpv(t.mpv, [
				"--no-video",
				`--input-ipc-server=${IPC_PATH}`,
				`--title=${station.name}`,
				streamUrl,
			]);
			mpvProcess = child;
			await new Promise((r) => setTimeout(r, 1500));
			if (gen !== playGen) return "Stopped.";
			if (exited.has(child)) return `Could not play: mpv exited right away. Run /dj doctor.`;
			ipcReady = true;
			isPlaying = true;
			startClock();
			sourceKind = "direct";
			currentTrack = { title: station.name, url: streamUrl };

			const alternatives = stations
				.slice(1)
				.map((s: any) => s.name)
				.join(", ");
			return `Radio: ${station.name} (${station.country})\nAlso: ${alternatives || "none"}`;
		} catch (err) {
			return `Radio search failed: ${(err as Error).message}`;
		}
	}

	/** Pause / resume toggle */
	async pause(): Promise<string> {
		if (!isPlaying) return "Nothing playing.";
		await mpvIpc({ command: ["cycle", "pause"] });
		// Believe the player over the toggle: if mpv answers, its pause flag is the
		// state; if it does not (no IPC), the toggle is all there is.
		const real = ipcReady ? await mpvGet("pause") : null;
		isPaused = real == null ? !isPaused : real === "true";
		clockPause(isPaused);
		return isPaused ? "Paused." : "Resumed.";
	}

	/**
	 * Stop playback: the DJ's own mpv and any afplay its music Player started,
	 * each by its own child handle. Never a name pattern (#3183). A search
	 * still in flight is abandoned, so it cannot start a player afterwards.
	 */
	stop(): string {
		playGen++;
		this.killMpv();
		stopOwnPlayers();
		trackQueue = [];
		return "Stopped.";
	}

	/** Now playing info */
	async nowPlaying(): Promise<string> {
		if (!isPlaying) return "Nothing playing.";
		const pos = ipcReady ? await mpvGet("time-pos") : null;
		const dur = ipcReady ? await mpvGet("duration") : null;
		const icon = isPaused ? "Paused" : isLooping ? "Looping" : "Playing";
		const time = pos && dur ? ` [${this.fmt(+pos)}/${this.fmt(+dur)}]` : "";
		const q = trackQueue.length ? ` (+${trackQueue.length} queued)` : "";
		if (ipcReady) await refreshTrackInfo(dur ? +dur : null, pos ? +pos : null);
		const name = info.name || currentTrack.title;
		const by = info.artists.length ? ` by ${info.artists.join(", ")}` : "";
		const key = keyLabel(currentKey());
		return `${icon}: ${name}${by}${key ? ` | ${key}` : ""}${time}${q}`;
	}

	/**
	 * Set volume (0-150). It is remembered for later tracks and sessions
	 * (#3190), so it applies even when nothing plays yet. Mute is not remembered.
	 */
	async volume(level: number): Promise<string> {
		const v = clampVolume(level);
		rememberVolume(v);
		if (!isPlaying) return `Volume: ${v}% (for the next track)`;
		await mpvSet("volume", v);
		// Say what mpv now has, not what we sent: with no answer the track is unchanged.
		const got = await mpvGet("volume");
		if (got == null)
			return `Volume: ${v}% saved, but the player did not answer, so this track's volume is unchanged.`;
		return `Volume: ${Math.round(Number.parseFloat(got))}%`;
	}

	/** The volume the next track starts at, for a deck that shows it before anything plays. */
	preferredVolume(): number {
		return preferredVolume();
	}

	/** Skip to next in queue */
	async skip(): Promise<string> {
		if (trackQueue.length === 0) {
			this.killMpv();
			return "Queue empty. Stopped.";
		}
		const next = trackQueue.shift()!;
		return await this.play(next.url || next.title);
	}

	/** Toggle repeat */
	repeat(): string {
		isLooping = !isLooping;
		if (isPlaying && ipcReady) {
			mpvSet("loop-file", isLooping ? "inf" : "no");
		}
		return isLooping ? "Repeat ON" : "Repeat OFF";
	}

	/** Add to queue */
	queue(queryOrUrl: string): string {
		trackQueue.push({ title: queryOrUrl, url: queryOrUrl });
		return `Queued: ${queryOrUrl} (${trackQueue.length} in queue)`;
	}

	/** Get play history */
	getHistory(): { title: string; url: string; playedAt: number }[] {
		return history.slice(-20);
	}

	/** Download from SoundCloud */
	download(url: string): string {
		const t = detectTools();
		if (!t.ytdlp) return "yt-dlp not installed.";

		try {
			const outPath = join(MUSIC_DIR, "%(title)s.%(ext)s");
			execFileSync(t.ytdlp, ["-x", "--audio-format", "mp3", "-o", outPath, url], {
				timeout: 60000,
				stdio: "ignore",
				windowsHide: true,
			});
			return `Downloaded to ${MUSIC_DIR}`;
		} catch (err) {
			return `Download failed: ${(err as Error).message}`;
		}
	}

	/** Detect BPM of a file */
	bpm(filePath: string): string {
		const t = detectTools();
		if (!t.sox) return "sox not installed.";
		if (!existsSync(filePath)) return `File not found: ${filePath}`;
		if (PLATFORM === "win32")
			return "BPM detection needs a POSIX shell and is not available on Windows yet.";

		try {
			// Use sox + ffmpeg to estimate BPM via onset detection. The file path and tool
			// paths reach the shell as positional parameters, never spliced into the script.
			const result = execFileSync(
				"/bin/sh",
				[
					"-c",
					'"$1" "$3" -t raw -r 44100 -e float -c 1 - 2>/dev/null | ' +
						'"$2" -f f32le -ar 44100 -ac 1 -i - -af "aresample=44100,highpass=f=100,lowpass=f=200,agate=threshold=0.01" -f null - 2>&1 | grep -o "pts_time:[0-9.]*" | head -50',
					"sh",
					t.sox,
					t.ffmpeg ?? "ffmpeg",
					filePath,
				],
				{ encoding: "utf-8", timeout: 30000 },
			);
			// Count onsets and estimate BPM from inter-onset intervals
			const times =
				result.match(/pts_time:([0-9.]+)/g)?.map((s) => Number.parseFloat(s.split(":")[1])) || [];
			if (times.length < 4) return "Could not detect BPM (too few onsets).";

			const intervals = times.slice(1).map((t, i) => t - times[i]);
			const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
			const bpm = Math.round(60 / avgInterval);

			return `Estimated BPM: ${bpm}`;
		} catch {
			return "BPM detection failed.";
		}
	}

	/** Crossfade mix two files */
	mix(fileA: string, fileB: string, crossfadeSec = 5): string {
		const t = detectTools();
		if (!t.ffmpeg) return "ffmpeg not installed.";
		if (!existsSync(fileA) || !existsSync(fileB)) return "One or both files not found.";

		const outPath = join(MUSIC_DIR, `mix-${Date.now()}.mp3`);
		try {
			execFileSync(
				t.ffmpeg,
				[
					"-y",
					"-i",
					fileA,
					"-i",
					fileB,
					"-filter_complex",
					`[0:a]afade=t=out:st=0:d=${crossfadeSec}[a0];[1:a]afade=t=in:st=0:d=${crossfadeSec}[a1];[a0][a1]acrossfade=d=${crossfadeSec}[out]`,
					"-map",
					"[out]",
					outPath,
				],
				{ timeout: 60000, stdio: "ignore", windowsHide: true },
			);
			return `Mixed: ${outPath}`;
		} catch {
			return "Mix failed.";
		}
	}

	/** Resume last session */
	async resume(): Promise<string> {
		const state = loadResume();
		if (!state) return "Nothing to resume.";
		const result = await this.play(state.url);
		if (state.positionSec > 0 && ipcReady) {
			await mpvSet("time-pos", state.positionSec);
		}
		return `Resumed: ${state.title} at ${this.fmt(state.positionSec)}`;
	}

	/** List available radio presets */
	radioPresets(): string[] {
		return Object.keys(RADIO_PRESETS);
	}

	/**
	 * Structured playback status for UIs (HUD widget, dashboard, etc).
	 * `position` and `duration` come from mpv IPC and may briefly be null
	 * after a track change while mpv loads metadata.
	 */
	async status(): Promise<{
		/** mpv answered on its control socket just now; false means volume and clock are not its words. */
		ipc: boolean;
		/** Why nothing is heard, in words, or "" when all is well. */
		trouble: string;
		playing: boolean;
		paused: boolean;
		looping: boolean;
		title: string;
		url: string;
		position: number | null;
		duration: number | null;
		volume: number | null;
		queueSize: number;
		/** The track's name from its metadata (falls back to title). */
		name: string;
		/** Every artist the source names; empty when it names none. */
		artists: string[];
		/** "Key: A minor (est.)", "Key: detecting...", "Key: unknown", or "" when nothing plays. */
		keyLabel: string;
	}> {
		const [pos, dur, vol] = ipcReady
			? await Promise.all([mpvGet("time-pos"), mpvGet("duration"), mpvGet("volume")])
			: [null, null, null];
		// Believe the player, not our own flag: a track that failed to load leaves mpv
		// alive and idle (--idle=yes), and a phone with no audio device plays to nowhere.
		let trouble = "";
		let pausedNow = isPaused;
		if (ipcReady && isPlaying) {
			const health = await readAudioHealth();
			// The player's pause flag is the truth; ours only stands in when it is silent.
			if (health.ipc && health.paused != null) {
				pausedNow = health.paused;
				if (pausedNow !== isPaused) {
					isPaused = pausedNow;
					clockPause(isPaused);
				}
			}
			const verdict = diagnoseAudio(health, Date.now() - clock.startedAt, playerErrors.at(-1));
			if (!verdict.ok) {
				if (verdict.kind === "ended") {
					this.killMpv();
					return { ...EMPTY_STATUS, ipc: true };
				}
				trouble =
					verdict.kind === "no-output"
						? `no sound output: ${verdict.reason}`
						: `could not play: ${verdict.reason}`;
			}
		}
		const durN = dur ? Number.parseFloat(dur) : null;
		if (ipcReady && isPlaying) await refreshTrackInfo(durN, pos ? Number.parseFloat(pos) : null);
		const playingInfo = isPlaying && infoSig !== "";
		// mpv did not say where it is: count from the process we started.
		const posN = pos ? Number.parseFloat(pos) : isPlaying ? clockSeconds() : null;
		return {
			ipc: ipcReady && vol != null,
			trouble,
			playing: isPlaying,
			paused: pausedNow,
			looping: isLooping,
			title: currentTrack.title,
			url: currentTrack.url,
			position: posN,
			duration: dur ? Number.parseFloat(dur) : null,
			volume: vol ? Number.parseFloat(vol) : null,
			queueSize: trackQueue.length,
			name: playingInfo ? info.name : "",
			artists: playingInfo ? info.artists : [],
			keyLabel: playingInfo ? keyLabel(currentKey()) : "",
		};
	}

	// ---- Private ----
	/** Start mpv at the remembered volume, as the DJ's own child. */
	private spawnMpv(mpv: string, args: string[]): ChildProcess {
		playerErrors = [];
		const child = spawnImpl(mpv, mpvStartArgs(preferredVolume(), args), {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		child.unref?.();
		child.stdout?.on?.("data", notePlayerOutput);
		child.stderr?.on?.("data", notePlayerOutput);
		// The process is the truth. If it ends (track over, killed by Android, no
		// audio device), the deck must stop saying "playing" (#4907). A child we
		// already replaced or stopped is no longer mpvProcess, so its exit changes nothing.
		const ended = () => {
			exited.add(child);
			if (mpvProcess === child) this.killMpv();
		};
		child.on?.("exit", ended);
		child.on?.("error", ended);
		return child;
	}

	private killMpv(): void {
		ipcReady = false;
		abandonDetections();
		info = EMPTY_INFO;
		infoSig = "";
		infoLoaded = false;
		infoKeyId = "";
		keyPending = "";
		if (mpvProcess) {
			// Save resume state before killing
			if (currentTrack.url) {
				mpvGet("time-pos").then((pos) => {
					if (pos) saveResume(currentTrack.title, currentTrack.url, +pos);
				});
			}
			try {
				mpvProcess.kill("SIGTERM");
			} catch {}
			mpvProcess = null;
		}
		isPlaying = false;
		isPaused = false;
		currentTrack = { title: "", url: "" };
	}

	private fmt(s: number): string {
		return `${Math.floor(s / 60)}:${Math.floor(s % 60)
			.toString()
			.padStart(2, "0")}`;
	}
}
