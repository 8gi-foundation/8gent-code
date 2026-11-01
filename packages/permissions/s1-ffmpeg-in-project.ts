/**
 * System One passes a plain `ffmpeg` call that builds a NEW media file from the
 * workspace's own files without asking the model judge (L6 media, 11 Oct 2026).
 *
 * Why: media-brief-video joins slides and narration with ffmpeg. The judge has
 * no filesystem to look at, so a plain `ffmpeg -loop 1 -i slide1.png -i n1.wav
 * ... seg1.mp4` is an "escalate", which is a refusal in a headless run. The
 * magick and ffprobe halves of the same job passed in #3948; this is the
 * writer half.
 *
 * Default mode only, wired in system-one-gate.ts, needs the working directory.
 * ok needs ALL of:
 *   - one command: no pipe, redirect, `;`, `&`, `$`, backtick, newline; the
 *     rules and the prompt-control check pass; no secret name; at most 60 words;
 *   - every option is on the lists below with its value checked by kind; no
 *     filter graph beyond scale/format/fps/setsar/setpts; no `-f` except
 *     `concat` on an input; no protocol, no device, no `lavfi`;
 *   - every input is a relative path to an existing regular file inside the
 *     workspace, no symlink, no `..`, no dot directory, no `: , | % *`, whose
 *     first bytes are a real PNG, JPEG, WAV, MP3, MP4/M4A, Ogg or FLAC header
 *     (ffmpeg sniffs content, so a text file named .wav must not pass);
 *   - a concat list is a plain file of `file 'name'` and `duration N` lines
 *     only, each name a relative existing workspace media file;
 *   - the output is the last argument, a NEW file (must not exist, a dangling
 *     link counts) with a media extension, in a real directory inside the
 *     workspace. It can never overwrite code or an existing file, so `-y` is
 *     harmless and allowed;
 *   - nothing runs forever: `-loop 1` needs `-t` or `-shortest`; `-t` <= 600.
 * Anything else goes to the judge as before.
 *
 * Accepted TOCTOU window, same as s1-rm-single.ts. Synchronous, never throws.
 */

import { closeSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import * as path from "node:path";
import { promptControlText } from "../decide/guard";
import { decideRules, maskQuotes, shellWords, splitSegments } from "../decide/rules";
import { protectedRel } from "./s1-mv-in-project";
import { inside } from "./s1-rm-nothing";
import { SECRET, canon, symlinkBelow } from "./s1-run-in-project";

export type FfmpegInProject = { ok: true; reason: string } | { ok: false };
const NO: FfmpegInProject = { ok: false };

const MAX_WORDS = 60;
const MAX_WORD_LEN = 300;
const MAX_SECONDS = 600;
const MAX_LIST_BYTES = 4096;
const MAX_LIST_LINES = 200;
const OPTION = /^-[a-zA-Z]/;
const OUT_EXT = /\.(mp4|m4a|mov|mkv|webm|wav|mp3|aac|ts)$/i;
const IN_EXT = /\.(png|jpe?g|wav|mp3|mp4|m4a|mov|ogg|flac|aac)$/i;
const LIST_EXT = /\.(txt|list)$/i;
const VCODEC = new Set(["libx264", "libx265", "mpeg4", "libvpx-vp9", "copy"]);
const ACODEC = new Set(["aac", "libmp3lame", "pcm_s16le", "libopus", "copy"]);
const PRESET = new Set(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium"]);
const FILTERS = new Set(["scale", "format", "fps", "setsar", "setpts", "pad"]);
const BARE = new Set([
	"y",
	"n",
	"shortest",
	"an",
	"vn",
	"hide_banner",
	"nostdin",
	"stats",
	"nostats",
]);

interface Ctx {
	root: string;
}

const lstatOrNull = (p: string) => lstatSync(p, { throwIfNoEntry: false }) ?? null;

function workspacePath(p: string, cx: Ctx): { abs: string } | null {
	if (!p || /^[/~-]/.test(p) || /[*?[\]{}$%:,|\\]/.test(p) || SECRET.test(p)) return null;
	if (p.split("/").includes("..")) return null;
	const lexical = path.resolve(cx.root, p);
	if (!inside(canon(lexical), cx.root) || !inside(lexical, cx.root)) return null;
	const rel = path.relative(cx.root, lexical);
	if (rel === "" || SECRET.test(rel) || protectedRel(rel)) return null;
	const segs = rel.split("/");
	if (segs.some((s) => s.startsWith(".")) || segs.includes("node_modules")) return null;
	if (symlinkBelow(cx.root, lexical)) return null;
	return { abs: lexical };
}

function head16(abs: string): Buffer | null {
	let fd = -1;
	try {
		fd = openSync(abs, "r");
		const b = Buffer.alloc(16);
		return b.subarray(0, readSync(fd, b, 0, 16, 0));
	} catch {
		return null;
	} finally {
		if (fd >= 0) closeSync(fd);
	}
}

/** A binary media header, never a text playlist or script that ffmpeg would follow. */
function isMediaBytes(b: Buffer): boolean {
	const t = b.toString("latin1");
	const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
	return (
		at(0, 0x89, 0x50, 0x4e, 0x47) || // PNG
		at(0, 0xff, 0xd8, 0xff) || // JPEG
		(t.startsWith("RIFF") && t.slice(8, 12) === "WAVE") ||
		t.startsWith("ID3") ||
		(b[0] === 0xff && (b[1] & 0xe0) === 0xe0) || // MPEG audio frame
		t.slice(4, 8) === "ftyp" || // MP4, M4A, MOV
		t.startsWith("OggS") ||
		t.startsWith("fLaC") ||
		at(0, 0x1a, 0x45, 0xdf, 0xa3) // Matroska, WebM
	);
}

function regularFile(p: string, cx: Ctx): string | null {
	const w = workspacePath(p, cx);
	if (!w) return null;
	const st = lstatOrNull(w.abs);
	return st?.isFile() && !st.isSymbolicLink() ? w.abs : null;
}

function mediaInput(p: string, cx: Ctx): boolean {
	if (!IN_EXT.test(p)) return false;
	const abs = regularFile(p, cx);
	const b = abs ? head16(abs) : null;
	return !!b && isMediaBytes(b);
}

/** A concat list: only `file 'x'` and `duration N` lines, each file a workspace media file. */
function concatList(p: string, cx: Ctx): boolean {
	if (!LIST_EXT.test(p)) return false;
	const abs = regularFile(p, cx);
	if (!abs) return false;
	try {
		const st = lstatSync(abs);
		if (st.size > MAX_LIST_BYTES) return false;
		const dir = path.dirname(path.relative(cx.root, abs));
		const lines = readFileSync(abs, "utf8")
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith("#"));
		if (lines.length === 0 || lines.length > MAX_LIST_LINES) return false;
		for (const line of lines) {
			if (/^duration\s+\d+(\.\d+)?$/.test(line)) continue;
			const m = /^file\s+(?:'([^'\\]+)'|"([^"\\]+)"|([A-Za-z0-9._/-]+))$/.exec(line);
			const name = m?.[1] ?? m?.[2] ?? m?.[3];
			// With -safe 0 ffmpeg opens an absolute entry as written, not under the list's folder, so
			// "/etc/x.wav" in sub/list.txt would read the real /etc/x.wav (8SO on #3960). Refuse
			// absolute, drive-letter and backslash entries outright.
			if (name && (/^[\\/]/.test(name) || /^[A-Za-z]:/.test(name) || name.includes("\\")))
				return false;
			// ffmpeg resolves list entries against the list's own directory.
			if (!name || !mediaInput(path.join(dir === "." ? "" : dir, name), cx)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function newOutput(p: string, cx: Ctx): boolean {
	if (!OUT_EXT.test(p)) return false;
	const w = workspacePath(p, cx);
	if (!w || lstatOrNull(w.abs)) return false;
	const parent = path.dirname(w.abs);
	if (parent === cx.root) return true;
	const pst = lstatOrNull(parent);
	return !!pst && pst.isDirectory() && !pst.isSymbolicLink();
}

const num = (v: string, max: number) => /^\d{1,6}(\.\d{1,6})?$/.test(v) && Number(v) <= max;

function filterOk(v: string): boolean {
	if (!/^[A-Za-z0-9=:.,_*+()-]+$/.test(v) || /[\\/]/.test(v)) return false;
	return v.split(",").every((f) => {
		const name = f.split("=")[0];
		if (!FILTERS.has(name)) return false;
		const dims = (f.match(/\d+/g) ?? []).map(Number);
		return dims.every((n) => n <= 8192);
	});
}

function ffmpegOk(args: string[], cx: Ctx): boolean {
	let inputs = 0;
	let loop = false;
	let bounded = false;
	let concat = false;
	let output: string | null = null;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (!OPTION.test(a)) {
			// The one bare argument is the output, and it is last.
			if (i !== args.length - 1 || output !== null) return false;
			output = a;
			continue;
		}
		const name = a.slice(1);
		if (BARE.has(name)) {
			if (name === "shortest") bounded = true;
			continue;
		}
		const v = args[++i];
		if (v === undefined) return false;
		switch (name) {
			case "i":
				if (concat ? !concatList(v, cx) : !mediaInput(v, cx)) return false;
				inputs++;
				concat = false;
				break;
			case "f":
				if (v !== "concat" || concat) return false;
				concat = true;
				break;
			case "safe":
				if (!/^[01]$/.test(v)) return false; // the list is vetted above
				break;
			case "loop":
				if (v !== "1") return false;
				loop = true;
				break;
			case "t":
				if (!num(v, MAX_SECONDS)) return false;
				bounded = true;
				break;
			case "r":
			case "framerate":
				if (!num(v, 60)) return false;
				break;
			case "ar":
				if (!num(v, 96000)) return false;
				break;
			case "ac":
				if (!/^[12]$/.test(v)) return false;
				break;
			case "crf":
				if (!/^\d{1,2}$/.test(v) || Number(v) > 51) return false;
				break;
			case "preset":
				if (!PRESET.has(v)) return false;
				break;
			case "pix_fmt":
				if (!/^[a-z0-9]{3,12}$/.test(v)) return false;
				break;
			case "c:v":
			case "vcodec":
				if (!VCODEC.has(v)) return false;
				break;
			case "c:a":
			case "acodec":
				if (!ACODEC.has(v)) return false;
				break;
			case "c":
				if (v !== "copy") return false;
				break;
			case "b:a":
			case "b:v":
				if (!/^\d{1,5}[kM]?$/.test(v)) return false;
				break;
			case "s": {
				const m = /^(\d{2,4})x(\d{2,4})$/.exec(v);
				if (!m || Number(m[1]) > 4096 || Number(m[2]) > 4096) return false;
				break;
			}
			case "movflags":
				if (v !== "+faststart" && v !== "faststart") return false;
				break;
			case "map":
				if (!/^\d{1,2}:[va](:\d{1,2})?$/.test(v)) return false;
				break;
			case "v":
			case "loglevel":
				if (!/^(quiet|panic|fatal|error|warning|info)$/.test(v)) return false;
				break;
			case "vf":
				if (!filterOk(v)) return false;
				break;
			default:
				return false;
		}
	}
	if (inputs === 0 || inputs > 4 || output === null || concat) return false;
	if (loop && !bounded) return false; // an endless image loop writes forever
	return newOutput(output, cx);
}

/** ok when `command` is a plain ffmpeg call that builds one new media file from workspace files. */
export function ffmpegInProject(command: string, cwd: string | undefined): FfmpegInProject {
	try {
		// The grammar is POSIX (paths are split on "/", so a\.git would be missed); on win32 the
		// lane has no opinion, like s1-deck-render.
		if (process.platform === "win32") return NO;
		if (!cwd || !path.isAbsolute(cwd)) return NO;
		const text = command.trim();
		if (!/^ffmpeg /.test(text) || promptControlText(text) !== null) return NO;
		if (/[$`\n\r]/.test(text) || SECRET.test(text)) return NO;
		if (decideRules(text).rules.length !== 0) return NO;
		const { segs, subs } = splitSegments(text);
		if (segs.length !== 1 || subs.length) return NO;
		if (/[<>|&;()]/.test(maskQuotes(text))) return NO;
		const words = shellWords(text);
		if (
			!words ||
			words.length < 4 ||
			words.length > MAX_WORDS ||
			words.some((w) => w.length > MAX_WORD_LEN)
		)
			return NO;
		const cx: Ctx = { root: canon(cwd) };
		return ffmpegOk(words.slice(1), cx)
			? { ok: true, reason: "ffmpeg building a new media file from workspace files" }
			: NO;
	} catch {
		return NO;
	}
}
