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

import {
	type ChildProcess,
	type SpawnOptions,
	execFileSync,
	execSync,
	spawn,
} from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { homedir, platform, tmpdir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import { getSettingsFilePath, loadSettings } from "../settings/store.js";
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
	try {
		return clampVolume(volumeStore.load() ?? DEFAULT_VOLUME);
	} catch {
		return DEFAULT_VOLUME;
	}
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
	if (plat === "linux") return "sudo apt install mpv yt-dlp ffmpeg sox";
	return "brew install mpv yt-dlp ffmpeg sox";
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
function which(cmd: string): string | null {
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

function mpvIpc(cmd: Record<string, any>): Promise<any> {
	if (!ipcReady) return Promise.resolve(null);
	const line = `${JSON.stringify(cmd)}\n`;
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

// ---- Playback State ----
let mpvProcess: ChildProcess | null = null;
/** Bumped by every play, radio and stop; a slower one that finds it moved on gives way. */
let playGen = 0;
let currentTrack = { title: "", url: "" };
let isPlaying = false;
let isPaused = false;
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

	/** Play a YouTube video/song by query or URL */
	async play(queryOrUrl: string): Promise<string> {
		const t = detectTools();
		if (!t.mpv) return `mpv not installed. Run: ${installHint()}`;
		if (!t.ytdlp && !queryOrUrl.startsWith("http"))
			return `yt-dlp not installed. Run: ${installHint()}`;

		let url = queryOrUrl;
		let title = queryOrUrl;
		// A stop or a newer play while this one searches wins (#3182).
		const gen = ++playGen;

		// If not a URL, search YouTube, off the event loop so the TUI keeps drawing.
		if (!queryOrUrl.startsWith("http")) {
			const found = await ytSearch(t.ytdlp!, queryOrUrl);
			if (gen !== playGen) return "Stopped.";
			if (!found) return `No results found for: ${queryOrUrl}`;
			title = found.title;
			url = found.url;
		}

		this.killMpv();

		mpvProcess = this.spawnMpv(t.mpv, [
			"--no-video",
			"--idle=yes",
			`--input-ipc-server=${IPC_PATH}`,
			`--title=${title}`,
			url,
		]);

		// Wait for IPC socket
		await new Promise((r) => setTimeout(r, 1500));
		if (gen !== playGen) return "Stopped.";
		ipcReady = true;

		currentTrack = { title, url };
		sourceKind = "ytdl";
		isPlaying = true;
		isPaused = false;
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
			mpvProcess = this.spawnMpv(t.mpv, ["--no-video", `--input-ipc-server=${IPC_PATH}`, query]);
			await new Promise((r) => setTimeout(r, 1500));
			if (gen !== playGen) return "Stopped.";
			ipcReady = true;
			isPlaying = true;
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
			mpvProcess = this.spawnMpv(t.mpv, [
				"--no-video",
				`--input-ipc-server=${IPC_PATH}`,
				`--title=${station.name}`,
				streamUrl,
			]);
			await new Promise((r) => setTimeout(r, 1500));
			if (gen !== playGen) return "Stopped.";
			ipcReady = true;
			isPlaying = true;
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
		isPaused = !isPaused;
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
		return `Volume: ${v}%`;
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
			// Use sox + ffmpeg to estimate BPM via onset detection
			const result = execSync(
				`${t.sox} "${filePath}" -t raw -r 44100 -e float -c 1 - 2>/dev/null | ` +
					`${t.ffmpeg} -f f32le -ar 44100 -ac 1 -i - -af "aresample=44100,highpass=f=100,lowpass=f=200,agate=threshold=0.01" -f null - 2>&1 | grep -o "pts_time:[0-9.]*" | head -50`,
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
		const durN = dur ? Number.parseFloat(dur) : null;
		if (ipcReady && isPlaying) await refreshTrackInfo(durN, pos ? Number.parseFloat(pos) : null);
		const playingInfo = isPlaying && infoSig !== "";
		return {
			playing: isPlaying,
			paused: isPaused,
			looping: isLooping,
			title: currentTrack.title,
			url: currentTrack.url,
			position: pos ? Number.parseFloat(pos) : null,
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
		const child = spawnImpl(mpv, [`--volume=${preferredVolume()}`, ...args], {
			stdio: "ignore",
			windowsHide: true,
		});
		child.unref?.();
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
