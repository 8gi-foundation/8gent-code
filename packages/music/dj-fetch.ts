/**
 * /dj play for a surface that cannot hear the host: resolve a query to one audio file and hand back its bytes (#5245).
 *
 * The Day8 game asks a vessel for a song and plays it in the room, so the vessel must return the audio instead of playing it on
 * its own speakers. Same tool as /dj (8gent's own yt-dlp, else PATH), run with no shell on `ytsearch1:<query>` only: a URL in the
 * query is search text, never fetched. Nothing is installed from here; a missing tool is a plain reason.
 */

import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findManagedDjTool } from "./dj-tools";

export const DJ_AUDIO_MAX_BYTES = 3 * 1024 * 1024;
export const DJ_QUERY_MAX = 200;
const FETCH_MS = 60_000;
const MAX_INFLIGHT = 2;

const MIME: Record<string, string> = {
	m4a: "audio/mp4",
	mp4: "audio/mp4",
	webm: "audio/webm",
	opus: "audio/ogg",
	ogg: "audio/ogg",
	mp3: "audio/mpeg",
};

export type DjAudio =
	| { ok: true; title: string; mime: string; bytes: Buffer }
	| { ok: false; reason: string };

export interface DjFetchIo {
	/** Where yt-dlp is, or null. */
	findTool: () => string | null;
	/** Run it; stdout on success. */
	run: (bin: string, args: string[]) => Promise<string>;
}

function whichYtDlp(): string | null {
	// a vessel names its own root-owned, pinned copy; the managed copy under the account's home is only for a machine that has no such pin
	const pinned = process.env.EIGHT_DJ_YTDLP;
	if (pinned && existsSync(pinned)) return pinned;
	const own = findManagedDjTool("yt-dlp");
	if (own) return own;
	const r = spawnSync("/bin/sh", ["-c", 'command -v "$1"', "sh", "yt-dlp"], { encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim().split("\n")[0] || null : null;
}

const runFile = (bin: string, args: string[]): Promise<string> =>
	new Promise((resolve, reject) => {
		execFile(
			bin,
			args,
			{ timeout: FETCH_MS, maxBuffer: 256 * 1024, shell: false },
			(err, stdout) => (err ? reject(err) : resolve(stdout)),
		);
	});

let inflight = 0;

export async function fetchDjAudio(
	query: string,
	io: DjFetchIo = { findTool: whichYtDlp, run: runFile },
): Promise<DjAudio> {
	const q = query.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim();
	if (!q || q.length > DJ_QUERY_MAX)
		return { ok: false, reason: "Usage: /dj play <song, artist or mood>" };
	const bin = io.findTool();
	if (!bin) return { ok: false, reason: "yt-dlp not installed on this vessel" };
	if (inflight >= MAX_INFLIGHT)
		return { ok: false, reason: "the DJ is busy, try again in a moment" };
	inflight++;
	const dir = mkdtempSync(join(tmpdir(), "dj-audio-"));
	try {
		const out = await io.run(bin, [
			"--no-playlist",
			"--no-warnings",
			"--ignore-config",
			"--no-plugin-dirs",
			"--socket-timeout",
			"15",
			"--match-filter",
			"duration<=900",
			"--max-filesize",
			String(DJ_AUDIO_MAX_BYTES),
			"-f",
			"bestaudio[ext=m4a][abr<=70]/bestaudio[abr<=70]/worstaudio[ext=m4a]/worstaudio",
			"-o",
			join(dir, "track.%(ext)s"),
			"--print",
			"%(title)s",
			"--no-simulate",
			`ytsearch1:${q}`,
		]);
		const title = out
			.split("\n")
			.map((l) => l.trim())
			.find(Boolean);
		const file = readdirSync(dir).find((f) => f.startsWith("track."));
		if (!title || !file) return { ok: false, reason: "could not find that song" };
		const path = join(dir, file);
		if (statSync(path).size > DJ_AUDIO_MAX_BYTES)
			return { ok: false, reason: "that track is too long to send" };
		const mime = MIME[file.split(".").pop()?.toLowerCase() ?? ""];
		if (!mime) return { ok: false, reason: "that track came in a format the speakers cannot play" };
		return { ok: true, title: title.slice(0, 200), mime, bytes: readFileSync(path) };
	} catch (e) {
		return {
			ok: false,
			reason: (e as { killed?: boolean }).killed
				? "the search took too long"
				: "could not find that song",
		};
	} finally {
		inflight--;
		rmSync(dir, { recursive: true, force: true });
	}
}
