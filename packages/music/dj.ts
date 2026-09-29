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

import { type ChildProcess, execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { homedir, platform, tmpdir } from "node:os";
import { basename, join, posix, win32 } from "node:path";

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
let currentTrack = { title: "", url: "" };
let isPlaying = false;
let isPaused = false;
let isLooping = false;
let trackQueue: { title: string; url: string }[] = [];
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

		// If not a URL, search YouTube
		if (!queryOrUrl.startsWith("http")) {
			try {
				const result = execFileSync(
					t.ytdlp!,
					["--print", "%(title)s\t%(webpage_url)s", `ytsearch1:${queryOrUrl}`],
					{
						encoding: "utf-8",
						timeout: 15000,
						stdio: ["ignore", "pipe", "ignore"],
						windowsHide: true,
					},
				).trim();
				const [t2, u] = result.split("\t");
				if (u) {
					title = t2;
					url = u;
				}
			} catch {
				return `No results found for: ${queryOrUrl}`;
			}
		}

		this.killMpv();

		mpvProcess = spawn(
			t.mpv,
			["--no-video", "--idle=yes", `--input-ipc-server=${IPC_PATH}`, `--title=${title}`, url],
			{ stdio: "ignore", windowsHide: true },
		);
		mpvProcess.unref();

		// Wait for IPC socket
		await new Promise((r) => setTimeout(r, 1500));
		ipcReady = true;

		currentTrack = { title, url };
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
			mpvProcess = spawn(t.mpv, ["--no-video", `--input-ipc-server=${IPC_PATH}`, query], {
				stdio: "ignore",
				windowsHide: true,
			});
			mpvProcess.unref();
			await new Promise((r) => setTimeout(r, 1500));
			ipcReady = true;
			isPlaying = true;
			currentTrack = { title: `Radio: ${query}`, url: query };
			return `Radio streaming: ${query}`;
		}

		// Preset or search
		const searchTerm = RADIO_PRESETS[query.toLowerCase()] || query;

		try {
			const res = await fetch(
				`${RADIO_API}/stations/search?name=${encodeURIComponent(searchTerm)}&limit=5&order=votes&reverse=true`,
			);
			const stations = (await res.json()) as any[];

			if (!stations || stations.length === 0) return `No radio stations found for: ${query}`;

			const station = stations[0];
			const streamUrl = station.url_resolved || station.url;

			this.killMpv();
			mpvProcess = spawn(
				t.mpv,
				["--no-video", `--input-ipc-server=${IPC_PATH}`, `--title=${station.name}`, streamUrl],
				{ stdio: "ignore", windowsHide: true },
			);
			mpvProcess.unref();
			await new Promise((r) => setTimeout(r, 1500));
			ipcReady = true;
			isPlaying = true;
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

	/** Stop playback */
	stop(): string {
		this.killMpv();
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
		return `${icon}: ${currentTrack.title}${time}${q}`;
	}

	/** Set volume (0-100) */
	async volume(level: number): Promise<string> {
		if (!isPlaying) return "Nothing playing.";
		await mpvSet("volume", Math.max(0, Math.min(150, level)));
		return `Volume: ${level}%`;
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
	}> {
		const [pos, dur, vol] = ipcReady
			? await Promise.all([mpvGet("time-pos"), mpvGet("duration"), mpvGet("volume")])
			: [null, null, null];
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
		};
	}

	// ---- Private ----
	private killMpv(): void {
		ipcReady = false;
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
