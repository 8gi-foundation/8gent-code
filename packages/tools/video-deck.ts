/**
 * 8gent Code - render_video_deck core
 *
 * The model writes a JSON spec; this code draws it. No model, no network, no shell:
 * slides are painted with @napi-rs/canvas, optional narration comes from the local
 * `speak` engine, and ffmpeg joins them with a fixed argv. Same spec in, same
 * pixels and same stream layout out.
 *
 * Concept lifted from the house deck renderers (deck2video-lite, officerfilm):
 * structured slide JSON in, deterministic frames, local TTS, ffmpeg concat.
 * Rebuilt here so it works for any user, with nothing read from outside the repo.
 * The paint is officerfilm's look (#4263): glow and dust background, spaced-caps
 * header and counter, serif title, numbered accent cards, the narration captioned,
 * and a 12-frame entrance that settles into one held still per slide.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

export const FPS = 24;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 25_000_000;
export const MAX_TOTAL_SECONDS = 600;
export const DEFAULT_DEADLINE_MS = 300_000;
export const MAX_SLIDES = 40;
const SIZES = { "1280x720": [1280, 720], "1920x1080": [1920, 1080] } as const;

const text = (max: number) => z.string().max(max);

export const SlideSchema = z
	.object({
		kicker: text(80).optional(),
		title: text(160).optional(),
		text: text(600).optional(),
		bullets: z.array(text(240)).max(8).optional(),
		/** Raster image (png/jpg) inside the working directory. Never a URL. */
		image: text(260).optional(),
		seconds: z.number().min(1).max(60).optional(),
		/** Spoken over this slide by the local `speak` engine. */
		narration: text(1200).optional(),
		voice: text(40).optional(),
	})
	.strict()
	.refine((s) => s.title || s.text || s.bullets?.length || s.image, {
		message: "a slide needs at least one of title, text, bullets or image",
	});

export const DeckSpecSchema = z
	.object({
		title: text(160).optional(),
		size: z.enum(["1280x720", "1920x1080"]).default("1280x720"),
		/** Default voice for slides that carry narration. */
		voice: text(40).optional(),
		slides: z.array(SlideSchema).min(1).max(MAX_SLIDES),
	})
	.strict();

export type DeckSpec = z.infer<typeof DeckSpecSchema>;
export type DeckSlide = z.infer<typeof SlideSchema>;

export interface RenderDeckOptions {
	spec: unknown;
	/** Absolute mp4 path, already confined to the working directory by the caller. */
	out: string;
	/** Working directory: slide images are read from inside it only. */
	cwd: string;
	timeoutMs?: number;
	/** One deadline for the whole render, narration included (default 300s). */
	deadlineMs?: number;
	/** Override for tests. Default: `ffmpeg` / `ffprobe` on PATH, or EIGHT_FFMPEG / EIGHT_FFPROBE. */
	ffmpeg?: string;
	ffprobe?: string;
}

/** Every number here is read back from the written file by ffprobe, never taken from the spec. */
export interface RenderDeckResult {
	path: string;
	durationSec: number;
	/** Picture stream length; with audio, the sound stream length. They match within a frame. */
	videoSec: number;
	audioSec: number | null;
	slides: number;
	width: number;
	height: number;
	hasAudio: boolean;
	kind: "video";
	/** Start of each slide in seconds, from the frame counts that were joined. */
	starts: number[];
	/** 'm:ss Title' lines, one per slide, also written to chaptersPath. */
	chapters: string[];
	/** chapters.txt next to the mp4. */
	chaptersPath: string;
	/** True total length as 'm:ss', read back from the written file. */
	durationLabel: string;
}

/** The one description both tool surfaces show (first sentence = input shape, per the local-model rule). */
export const RENDER_VIDEO_DECK_DESCRIPTION =
	"Slides + narration to MP4 from args {spec:{size, slides:[{title, bullets, narration}]}, out:'deck.mp4'}. " +
	"One call draws, voices and joins the video, writes chapters.txt ('m:ss Title' per slide) beside it and returns { path, durationSec, durationLabel, starts, chapters }, so no ffmpeg, ffprobe or build.sh is needed. " +
	"The chapters file is always named chapters.txt in the mp4's folder, so a second deck rendered there overwrites it. Local code only. Deterministic. " +
	"PREFER THIS over hand-written ffmpeg/magick/Pillow commands for any 'make a video / deck / brief film / slideshow' task: you write the spec, it draws the slides and joins them. " +
	"spec = { title?, size?: '1280x720'|'1920x1080', voice?, slides: [{ kicker?, title?, text?, bullets?: string[], image?: 'png/jpg path in the working directory', seconds?: 1-60 (default 4), narration?: 'spoken by the local voice', voice? }] } (1-40 slides, each needs a title, text, bullets or image). " +
	"Narration uses the same local engine as speak and stretches a slide to fit its voice. No music, no network. Never shells out.";

/** Where the chapters file for an mp4 goes: fixed name, same folder. */
export function chaptersPathFor(out: string): string {
	return path.join(path.dirname(out), "chapters.txt");
}

/**
 * Refuse before any render work if chapters.txt cannot be replaced cleanly: a symlink or a
 * directory is in the way. (The final write is temp-and-rename, which never follows a link.)
 */
export function assertChaptersWritable(chaptersPath: string): void {
	const st = fs.lstatSync(chaptersPath, { throwIfNoEntry: false });
	if (st?.isSymbolicLink()) throw new Error("refusing to write chapters.txt: it is a symlink");
	if (st?.isDirectory()) throw new Error("refusing to write chapters.txt: it is a directory");
}

/**
 * m:ss rounded to the nearest second (half the error of flooring). A slide lasts at least 1 s,
 * so the rounded start never lands past that slide's own end.
 */
export function clock(sec: number): string {
	const t = Math.max(0, Math.round(sec));
	return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

function chapterTitle(s: DeckSlide, i: number): string {
	const raw = s.title ?? s.text ?? s.bullets?.[0] ?? s.kicker ?? `Slide ${i + 1}`;
	return raw.replace(/\s+/g, " ").trim().slice(0, 80) || `Slide ${i + 1}`;
}

/** Chapter lines from per-slide start times; the first is always 0:00. */
export function chapterLines(slides: DeckSlide[], starts: number[]): string[] {
	return slides.map((s, i) => `${clock(starts[i])} ${chapterTitle(s, i)}`);
}

/** House film palette (officerfilm): warm near-black, cream ink, one amber accent. No hue 270-350. */
const COLORS = {
	bgTop: "#0b0a09",
	bgBottom: "#15120e",
	panel: "rgba(255,255,255,0.028)",
	ink: "#f3ece2",
	muted: "#b7a993",
	amber: "#e3a53c",
	line: "rgba(227,165,60,0.45)",
};

/**
 * Faces by name, with fallbacks, so a missing font never fails a render. Fraunces is the house
 * display face when installed; Georgia (macOS) and DejaVu (Linux) stand in for it. The canvas
 * sees one face per system .ttc family, so body text names Avenir (regular) and the spaced-caps
 * header names Avenir Next (bold).
 */
const SERIF = 'Fraunces, Georgia, "DejaVu Serif", serif';
const SANS = 'Avenir, "Helvetica Neue", "DejaVu Sans", sans-serif';
const CAPS = '"Avenir Next", Avenir, "Helvetica Neue", "DejaVu Sans", sans-serif';

/** The entrance: elements settle over this many frames, then the slide holds still. */
export const INTRO_FRAMES = 12;

type Ctx = import("@napi-rs/canvas").SKRSContext2D;

function wrap(ctx: Ctx, str: string, width: number): string[] {
	const out: string[] = [];
	for (const para of str.split("\n")) {
		let line = "";
		for (const word of para.split(/\s+/).filter(Boolean)) {
			const cand = line ? `${line} ${word}` : word;
			if (ctx.measureText(cand).width <= width || !line) line = cand;
			else {
				out.push(line);
				line = word;
			}
		}
		out.push(line);
	}
	return out;
}

/**
 * The bytes of a png/jpg inside root after following links, within the size and pixel limits.
 * Images are the only reads; make_docx and make_pptx read theirs through this too (#4274).
 */
export function readInside(named: string, cwd: string): Buffer {
	if (/^[a-z][a-z0-9+.-]*:/i.test(named) && !/^[a-z]:[\\/]/i.test(named)) {
		throw new Error(`image "${named}" must be a file inside the working directory, not a URL`);
	}
	const root = fs.realpathSync(cwd);
	const target = path.resolve(root, named);
	const real = fs.realpathSync(target);
	if (real !== root && !real.startsWith(root + path.sep)) {
		throw new Error(`Path traversal blocked: image "${named}" is outside the working directory`);
	}
	if (!/\.(png|jpe?g)$/i.test(real)) throw new Error(`image "${named}" must be a .png or .jpg`);
	const size = fs.statSync(real).size;
	if (size > MAX_IMAGE_BYTES)
		throw new Error(`image "${named}" is ${size} bytes; the limit is ${MAX_IMAGE_BYTES}`);
	const buf = fs.readFileSync(real);
	const dim = imageDimensions(buf);
	if (!dim) throw new Error(`image "${named}" has no readable PNG or JPEG header`);
	if (dim.width * dim.height > MAX_IMAGE_PIXELS) {
		throw new Error(
			`image "${named}" is ${dim.width}x${dim.height}; the limit is ${MAX_IMAGE_PIXELS} pixels`,
		);
	}
	return buf;
}

/** Width and height from the PNG IHDR or the first JPEG SOF marker, before any decoding. */
export function imageDimensions(b: Buffer): { width: number; height: number } | null {
	if (
		b.length >= 24 &&
		b.readUInt32BE(0) === 0x89504e47 &&
		b.toString("ascii", 12, 16) === "IHDR"
	) {
		return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
	}
	if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
		let i = 2;
		while (i + 9 < b.length) {
			if (b[i] !== 0xff) {
				i++;
				continue;
			}
			const m = b[i + 1];
			if (m === 0xff) {
				i++;
				continue;
			}
			if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
				return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
			}
			if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
				i += 2;
				continue;
			}
			i += 2 + b.readUInt16BE(i + 2);
		}
	}
	return null;
}

/** Lines of str that fit width, at most max of them; a cut last line ends in "...". */
function fitLines(ctx: Ctx, str: string, width: number, max: number): string[] {
	const lines = wrap(ctx, str, width);
	if (lines.length <= max) return lines;
	const kept = lines.slice(0, max);
	let last = kept[max - 1];
	while (last && ctx.measureText(`${last}...`).width > width) last = last.replace(/\s*\S+$/, "");
	kept[max - 1] = `${last}...`;
	return kept;
}

/** Spaced capitals, drawn one glyph at a time so the tracking is the same on every machine. */
function spacedCaps(
	ctx: Ctx,
	str: string,
	x: number,
	y: number,
	track: number,
	align: "left" | "right",
) {
	const chars = [...str.toUpperCase()];
	const widths = chars.map((c) => ctx.measureText(c).width);
	const total = widths.reduce((a, b) => a + b, 0) + track * Math.max(0, chars.length - 1);
	let cx = align === "left" ? x : x - total;
	chars.forEach((c, i) => {
		ctx.fillText(c, cx, y);
		cx += widths[i] + track;
	});
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}

/** Eased 0..1 share of the entrance window [a, b]; exactly 1 once t reaches b. */
export function phase(t: number, a: number, b: number): number {
	if (t >= b) return 1;
	if (t <= a) return 0;
	return 1 - (1 - (t - a) / (b - a)) ** 3;
}

/** Seeded PRNG (mulberry32): the dust field is the same on every render. */
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let r = Math.imul(s ^ (s >>> 15), 1 | s);
		r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
}

/** The house background: warm gradient, a soft amber glow from above, fixed dust, a vignette. */
function paintBackground(ctx: Ctx, W: number, H: number, k: number) {
	const g = ctx.createLinearGradient(0, 0, 0, H);
	g.addColorStop(0, COLORS.bgTop);
	g.addColorStop(1, COLORS.bgBottom);
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, W, H);
	const glow = ctx.createRadialGradient(W * 0.5, -H * 0.15, 0, W * 0.5, -H * 0.15, W * 0.75);
	glow.addColorStop(0, "rgba(227,165,60,0.16)");
	glow.addColorStop(1, "rgba(227,165,60,0)");
	ctx.fillStyle = glow;
	ctx.fillRect(0, 0, W, H);
	const r = rng(8);
	for (let i = 0; i < 140; i++) {
		const dx = r() * W;
		const dy = r() * H;
		const rad = (0.6 + r() * 1.4) * k;
		ctx.fillStyle = `rgba(243,220,180,${(0.04 + r() * 0.18).toFixed(3)})`;
		ctx.beginPath();
		ctx.arc(dx, dy, rad, 0, Math.PI * 2);
		ctx.fill();
	}
	const vig = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.75);
	vig.addColorStop(0, "rgba(0,0,0,0)");
	vig.addColorStop(1, "rgba(0,0,0,0.55)");
	ctx.fillStyle = vig;
	ctx.fillRect(0, 0, W, H);
}

/** Where a slide sits in the deck, and how far its entrance has run (t: 0 start, 1 settled). */
export interface PaintAt {
	index?: number;
	count?: number;
	t?: number;
}

/**
 * Paint one slide to PNG bytes in the house film look (officerfilm): spaced-caps amber header
 * with the slide counter, a serif display title, bullets as numbered accent cards, the narration
 * captioned in a lower block, and a staggered entrance while t runs 0 to 1 (1 = settled, held).
 * A slide with only a title is a centred title card. Pure function of (slide, size, image bytes,
 * deck title, at).
 */
export async function paintSlide(
	slide: DeckSlide,
	size: keyof typeof SIZES,
	cwd: string,
	deckTitle?: string,
	at: PaintAt = {},
): Promise<Buffer> {
	const { createCanvas, loadImage } = await import("@napi-rs/canvas");
	const [W, H] = SIZES[size];
	const k = W / 1280;
	const t = at.t ?? 1;
	const canvas = createCanvas(W, H);
	const ctx = canvas.getContext("2d");
	paintBackground(ctx, W, H, k);
	const x = 80 * k;
	const px = (n: number) => Math.round(n * k);
	const sans = (n: number, weight = 400) => `${weight} ${px(n)}px ${SANS}`;
	const serif = (n: number) => `600 ${px(n)}px ${SERIF}`;
	const fade = (a: number, draw: () => void) => {
		if (a <= 0) return;
		ctx.save();
		ctx.globalAlpha = a;
		draw();
		ctx.restore();
	};

	// Header: what this is on the left, where we are on the right.
	const head = slide.kicker ?? deckTitle;
	fade(phase(t, 0, 0.4), () => {
		ctx.font = `700 ${px(17)}px ${CAPS}`;
		ctx.fillStyle = COLORS.amber;
		if (head) spacedCaps(ctx, head, x, 64 * k, 4 * k, "left");
		if (at.count && at.count > 1 && at.index !== undefined) {
			const n = (v: number) => String(v).padStart(2, "0");
			ctx.fillStyle = COLORS.muted;
			spacedCaps(ctx, `${n(at.index + 1)} / ${n(at.count)}`, W - x, 64 * k, 4 * k, "right");
		}
	});

	// Caption block: the narration line, as officerfilm captions the sentence being spoken.
	const caption = slide.narration?.trim();
	let contentBottom = H - 60 * k;
	if (caption) {
		const capW = W - 184 * k;
		let capSize = 20;
		for (const s of [26, 23, 20]) {
			ctx.font = sans(s);
			capSize = s;
			if (wrap(ctx, caption, capW).length <= 3) break;
		}
		ctx.font = sans(capSize);
		const lines = fitLines(ctx, caption, capW, 3);
		const lh = capSize * 1.32 * k;
		const blockH = lines.length * lh;
		const top = H - 46 * k - blockH;
		contentBottom = top - 34 * k;
		fade(phase(t, 0.3, 0.8), () => {
			ctx.fillStyle = COLORS.amber;
			ctx.fillRect(x, top - 4 * k, 4 * k, blockH + 4 * k);
			ctx.fillStyle = COLORS.ink;
			ctx.font = sans(capSize);
			lines.forEach((ln, i) => ctx.fillText(ln, x + 24 * k, top + (i + 0.78) * lh));
		});
	}

	if (!slide.text && !slide.bullets?.length && !slide.image) {
		// Title card: centred display title over a short amber rule, like the film's cold open.
		ctx.font = serif(76);
		const lines = fitLines(ctx, slide.title ?? "", 1040 * k, 3);
		const lh = 86 * k;
		const top = 64 * k + (contentBottom - 64 * k) / 2 - (lines.length * lh) / 2 - 10 * k;
		const a = phase(t, 0.05, 0.6);
		fade(a, () => {
			ctx.font = serif(76);
			ctx.fillStyle = COLORS.ink;
			ctx.textAlign = "center";
			lines.forEach((ln, i) => ctx.fillText(ln, W / 2, top + (i + 0.8) * lh + (1 - a) * 18 * k));
		});
		const rw = 140 * k * phase(t, 0.25, 0.9);
		if (rw > 0) {
			ctx.fillStyle = COLORS.amber;
			ctx.fillRect(W / 2 - rw / 2, top + lines.length * lh + 18 * k, rw, 2 * k);
		}
		return canvas.toBuffer("image/png");
	}

	const textW = (slide.image ? 620 : 1120) * k;
	let y = 96 * k;
	if (slide.title) {
		ctx.font = serif(54);
		const lines = fitLines(ctx, slide.title, textW, 2);
		const a = phase(t, 0.05, 0.55);
		const y0 = y;
		fade(a, () => {
			ctx.font = serif(54);
			ctx.fillStyle = COLORS.ink;
			lines.forEach((ln, i) => ctx.fillText(ln, x, y0 + (50 + i * 62 + (1 - a) * 18) * k));
		});
		y += (lines.length * 62 + 18) * k;
	}
	if (slide.text) {
		ctx.font = sans(26, 400);
		const lines = fitLines(ctx, slide.text, textW, 3);
		const y0 = y;
		fade(phase(t, 0.15, 0.6), () => {
			ctx.font = sans(26, 400);
			ctx.fillStyle = COLORS.muted;
			lines.forEach((ln, i) => ctx.fillText(ln, x, y0 + (28 + i * 36) * k));
		});
		y += (lines.length * 36 + 18) * k;
	}

	const bullets = slide.bullets ?? [];
	if (bullets.length) {
		// The largest text size at which every card fits above the caption.
		let fs = 16;
		let cards: { lines: string[]; h: number }[] = [];
		for (const s of [24, 21, 18, 16]) {
			fs = s;
			ctx.font = sans(fs);
			cards = bullets.map((b) => {
				const lines = fitLines(ctx, b, textW - 92 * k, 2);
				return { lines, h: Math.max(lines.length * fs * 1.3 + fs * 1.24, fs * 2.3) * k };
			});
			if (cards.reduce((n, c) => n + c.h + fs * 0.45 * k, 0) <= contentBottom - y) break;
		}
		const lh = fs * 1.3 * k;
		const step = bullets.length > 1 ? Math.min(0.1, 0.35 / (bullets.length - 1)) : 0;
		cards.forEach((c, j) => {
			if (y + c.h > contentBottom + 1) return;
			const a = phase(t, 0.2 + j * step, 0.65 + j * step);
			const cy = y;
			fade(a, () => {
				ctx.translate((1 - a) * -26 * k, 0);
				roundRect(ctx, x, cy, textW, c.h, 12 * k);
				ctx.fillStyle = COLORS.panel;
				ctx.fill();
				ctx.strokeStyle = COLORS.line;
				ctx.lineWidth = Math.max(1, k);
				ctx.stroke();
				ctx.fillStyle = COLORS.amber;
				ctx.fillRect(x, cy + 8 * k, 4 * k, c.h - 16 * k);
				ctx.font = serif(fs * 1.45);
				ctx.fillText(String(j + 1), x + 26 * k, cy + c.h / 2 + fs * 0.5 * k);
				ctx.font = sans(fs);
				ctx.fillStyle = COLORS.ink;
				const top = cy + (c.h - c.lines.length * lh) / 2;
				c.lines.forEach((ln, i) => ctx.fillText(ln, x + 72 * k, top + (i + 0.76) * lh));
			});
			y += c.h + fs * 0.45 * k;
		});
	}

	if (slide.image) {
		const img = await loadImage(readInside(slide.image, cwd));
		const bx = 740 * k;
		const by = 96 * k;
		const bw = 460 * k;
		const bh = contentBottom - by;
		const s = Math.min((bw - 24 * k) / img.width, (bh - 24 * k) / img.height);
		const w = Math.round(img.width * s);
		const h = Math.round(img.height * s);
		fade(phase(t, 0.2, 0.7), () => {
			roundRect(ctx, bx, by, bw, bh, 14 * k);
			ctx.fillStyle = COLORS.panel;
			ctx.fill();
			ctx.strokeStyle = COLORS.line;
			ctx.lineWidth = Math.max(1, k);
			ctx.stroke();
			ctx.drawImage(img, bx + Math.round((bw - w) / 2), by + Math.round((bh - h) / 2), w, h);
		});
	}
	return canvas.toBuffer("image/png");
}

function run(
	cmd: string,
	argv: string[],
	timeoutMs: number,
): Promise<{ code: number | null; out: string; err: string }> {
	return new Promise((resolve, reject) => {
		// Fixed argv, no shell, a minimal environment, and a hard timeout.
		const child = spawn(cmd, argv, {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
			env: { PATH: process.env.PATH ?? "", LC_ALL: "C" } as unknown as NodeJS.ProcessEnv,
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			err = (err + d).slice(-4000);
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`${path.basename(cmd)} timed out after ${Math.round(timeoutMs / 1000)}s`));
		}, timeoutMs);
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(
				(e as NodeJS.ErrnoException).code === "ENOENT"
					? new Error(`${cmd} not found: render_video_deck needs ffmpeg installed locally`)
					: e,
			);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, out, err });
		});
	});
}

/** One slide for ffmpeg: its held still, its length, and optionally its voice and entrance frames. */
export interface DeckFrame {
	png: string;
	sec: number;
	wav?: string;
	/** Entrance frames before the still: an image2 pattern (e.g. in-%03d.png) and its frame count. */
	intro?: { pattern: string; count: number };
}

/** The exact ffmpeg argv for a deck. Exported so tests can assert it is network-free. */
export function buildFfmpegArgs(frames: DeckFrame[], out: string, anyAudio: boolean): string[] {
	const args = ["-y", "-hide_banner", "-loglevel", "error", "-nostdin"];
	const wavIndex: Record<number, number> = {};
	const introIndex: Record<number, number> = {};
	const stillIndex: Record<number, number> = {};
	let n = 0;
	frames.forEach((f, i) => {
		let hold = f.sec;
		if (f.intro) {
			args.push(
				"-protocol_whitelist",
				"file",
				"-framerate",
				String(FPS),
				"-start_number",
				"0",
				"-i",
				f.intro.pattern,
			);
			introIndex[i] = n++;
			// The still holds for the rest of the slide, in whole frames.
			hold = (Math.round(f.sec * FPS) - f.intro.count) / FPS;
		}
		args.push(
			"-protocol_whitelist",
			"file",
			"-loop",
			"1",
			"-framerate",
			String(FPS),
			"-t",
			hold.toFixed(3),
			"-i",
			f.png,
		);
		stillIndex[i] = n++;
	});
	frames.forEach((f, i) => {
		if (f.wav) {
			args.push("-protocol_whitelist", "file", "-i", f.wav);
			wavIndex[i] = n++;
		}
	});
	const parts: string[] = [];
	const labels: string[] = [];
	frames.forEach((f, i) => {
		const fmt = `format=yuv420p,setsar=1,fps=${FPS}`;
		if (f.intro) {
			parts.push(
				`[${introIndex[i]}:v]${fmt}[e${i}]`,
				`[${stillIndex[i]}:v]${fmt}[h${i}]`,
				`[e${i}][h${i}]concat=n=2:v=1:a=0[v${i}]`,
			);
		} else {
			parts.push(`[${stillIndex[i]}:v]${fmt}[v${i}]`);
		}
		labels.push(`[v${i}]`);
		if (anyAudio) {
			const d = f.sec.toFixed(3);
			parts.push(
				f.wav
					? `[${wavIndex[i]}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=500|500,apad=whole_dur=${d},atrim=0:${d},asetpts=N/SR/TB[a${i}]`
					: `anullsrc=r=48000:cl=stereo,atrim=0:${d},asetpts=N/SR/TB[a${i}]`,
			);
			labels.push(`[a${i}]`);
		}
	});
	parts.push(
		`${labels.join("")}concat=n=${frames.length}:v=1:a=${anyAudio ? 1 : 0}[v]${anyAudio ? "[a]" : ""}`,
	);
	args.push("-filter_complex", parts.join(";"), "-map", "[v]");
	if (anyAudio) args.push("-map", "[a]", "-c:a", "aac", "-b:a", "128k", "-ar", "48000");
	args.push(
		"-c:v",
		"libx264",
		"-preset",
		"medium",
		"-crf",
		"20",
		"-pix_fmt",
		"yuv420p",
		"-threads",
		"1",
		"-x264-params",
		"threads=1:sliced-threads=0",
		"-fflags",
		"+bitexact",
		"-flags:v",
		"+bitexact",
		"-flags:a",
		"+bitexact",
		"-map_metadata",
		"-1",
		"-movflags",
		"+faststart",
		out,
	);
	return args;
}

const insideRoot = (real: string, root: string) =>
	real === root || real.startsWith(root + path.sep);

/**
 * An absolute, executable path for a tool: a named absolute override, else the first ABSOLUTE
 * PATH entry that has it. Relative PATH entries (node_modules/.bin, ".") are skipped, and a
 * binary that resolves inside the workspace is refused, so a project cannot ship its own ffmpeg.
 */
export function resolveBinary(
	name: string,
	cwd: string,
	override?: string,
	pathEnv = process.env.PATH ?? "",
): string {
	const root = fs.realpathSync(cwd);
	const check = (cand: string): string | null => {
		try {
			const real = fs.realpathSync(cand);
			if (!fs.statSync(real).isFile()) return null;
			fs.accessSync(real, fs.constants.X_OK);
			if (insideRoot(real, root))
				throw new Error(
					`${name} resolves inside the working directory (${real}); refusing to run it`,
				);
			return cand;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code) return null;
			throw e;
		}
	};
	if (override) {
		if (!path.isAbsolute(override))
			throw new Error(`${name} override must be an absolute path ("${override}")`);
		const ok = check(override);
		if (!ok) throw new Error(`${name} not found at ${override}`);
		return ok;
	}
	for (const dir of pathEnv.split(path.delimiter)) {
		if (!dir || !path.isAbsolute(dir)) continue;
		const ok = check(path.join(dir, name));
		if (ok) return ok;
	}
	throw new Error(
		`${name} not found on an absolute PATH entry: render_video_deck needs ffmpeg installed locally`,
	);
}

/** Write src to out so a link swapped in after the checks cannot carry the write outside cwd. */
export function placeOutput(src: string, out: string, cwd: string): void {
	const root = fs.realpathSync(cwd);
	const parentOk = () => {
		const real = fs.realpathSync(path.dirname(out));
		if (!insideRoot(real, root))
			throw new Error(
				"Path traversal blocked: output parent resolves outside the working directory",
			);
		return real;
	};
	const parent = parentOk();
	const part = path.join(parent, `.deck-${randomBytes(8).toString("hex")}.part`);
	try {
		fs.copyFileSync(src, part, fs.constants.COPYFILE_EXCL);
		parentOk();
		// rename replaces a symlink at `out` rather than following it.
		fs.renameSync(part, path.join(parentOk(), path.basename(out)));
	} catch (e) {
		fs.rmSync(part, { force: true });
		throw e;
	}
}

export interface MediaProbe {
	durationSec: number;
	videoSec: number;
	audioSec: number | null;
	width: number;
	height: number;
}

const sec = (v: unknown) => Math.round(Number.parseFloat(String(v)) * 1000) / 1000;

/** One ffprobe pass: container length, picture size, and each stream's own length. */
export async function probeMedia(
	file: string,
	ffprobe: string,
	timeoutMs = 30000,
): Promise<MediaProbe> {
	const r = await run(
		ffprobe,
		[
			"-v",
			"error",
			"-show_entries",
			"stream=codec_type,width,height,duration:format=duration",
			"-of",
			"json",
			file,
		],
		timeoutMs,
	);
	type Probe = {
		streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[];
		format?: { duration?: string };
	};
	let j: Probe = {};
	try {
		j = JSON.parse(r.out) as Probe;
	} catch {}
	const v = j.streams?.find((s) => s.codec_type === "video");
	const a = j.streams?.find((s) => s.codec_type === "audio");
	const durationSec = sec(j.format?.duration);
	if (r.code !== 0 || !v?.width || !v.height || !Number.isFinite(durationSec)) {
		throw new Error(`ffprobe could not read a video stream from ${path.basename(file)}`);
	}
	const videoSec = sec(v.duration);
	const audioSec = a ? sec(a.duration) : null;
	return {
		durationSec,
		videoSec: Number.isFinite(videoSec) ? videoSec : durationSec,
		audioSec: audioSec !== null && Number.isFinite(audioSec) ? audioSec : null,
		width: v.width,
		height: v.height,
	};
}

export async function renderVideoDeck(opts: RenderDeckOptions): Promise<RenderDeckResult> {
	const parsed = DeckSpecSchema.safeParse(opts.spec);
	if (!parsed.success) {
		const msg = parsed.error.issues
			.map((i) => `${i.path.join(".") || "spec"}: ${i.message}`)
			.join("; ");
		throw new Error(`invalid deck spec: ${msg}`);
	}
	const spec = parsed.data;
	const deadline = Date.now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
	const left = () => {
		const ms = deadline - Date.now();
		if (ms <= 0) throw new Error("render deadline exceeded");
		return ms;
	};
	const declared = spec.slides.reduce((n, sl) => n + (sl.seconds ?? 4), 0);
	if (declared > MAX_TOTAL_SECONDS)
		throw new Error(`deck is ${declared}s; the limit is ${MAX_TOTAL_SECONDS}s`);
	const [W, H] = SIZES[spec.size];

	fs.mkdirSync(path.dirname(opts.out), { recursive: true });
	const chaptersPath = chaptersPathFor(opts.out);
	assertChaptersWritable(chaptersPath);
	const root = fs.realpathSync(opts.cwd);
	const scratchRoot = path.join(opts.cwd, ".tmp");
	if (fs.lstatSync(scratchRoot, { throwIfNoEntry: false })?.isSymbolicLink()) {
		throw new Error("refusing to use .tmp: it is a symlink");
	}
	fs.mkdirSync(scratchRoot, { recursive: true });
	if (!insideRoot(fs.realpathSync(scratchRoot), root))
		throw new Error("refusing to use .tmp: it resolves outside the working directory");
	const work = fs.mkdtempSync(path.join(scratchRoot, "video-deck-"));
	try {
		const frames: DeckFrame[] = [];
		const starts: number[] = [];
		let total = 0;
		const count = spec.slides.length;
		for (let i = 0; i < count; i++) {
			const s = spec.slides[i];
			const stem = path.join(work, `slide-${String(i).padStart(3, "0")}`);
			const png = `${stem}.png`;
			fs.writeFileSync(
				png,
				await paintSlide(s, spec.size, opts.cwd, spec.title, { index: i, count }),
			);
			let sec = s.seconds ?? 4;
			let wav: string | undefined;
			if (s.narration?.trim()) {
				const { speak } = await import("./speak");
				let timer: ReturnType<typeof setTimeout> | undefined;
				const ctl = new AbortController();
				const spoken = speak({
					text: s.narration,
					voice: s.voice ?? spec.voice,
					out: path.join(work, `vo-${String(i).padStart(3, "0")}.wav`),
					signal: ctl.signal,
				});
				spoken.catch(() => undefined);
				const r = await Promise.race([
					spoken,
					new Promise<never>((_, rej) => {
						// On the deadline the engine is killed (TERM, then KILL), not left running.
						timer = setTimeout(() => {
							ctl.abort();
							rej(new Error("render deadline exceeded during narration"));
						}, left());
					}),
				]).finally(() => clearTimeout(timer));
				wav = r.path;
				sec = Math.max(sec, r.durationSec + 1);
			}
			// Whole frames only, so the same spec always lands on the same frame count.
			const fixed = Math.ceil(sec * FPS) / FPS;
			starts.push(total);
			total += fixed;
			if (total > MAX_TOTAL_SECONDS)
				throw new Error(`deck is over ${MAX_TOTAL_SECONDS}s once narration is counted`);
			// The entrance: the slide's elements settle over INTRO_FRAMES, then the still holds,
			// so a viewer (and a still counter) sees one settled picture per slide.
			const introCount = Math.min(INTRO_FRAMES, Math.round(fixed * FPS) - 1);
			for (let f = 0; f < introCount; f++) {
				const at = { index: i, count, t: f / introCount };
				const frame = `${stem}-in-${String(f).padStart(3, "0")}.png`;
				fs.writeFileSync(frame, await paintSlide(s, spec.size, opts.cwd, spec.title, at));
			}
			const intro =
				introCount > 0 ? { pattern: `${stem}-in-%03d.png`, count: introCount } : undefined;
			frames.push({ png, sec: fixed, wav, intro });
		}
		// Caps, images and narration are all settled above; only now are the binaries looked up.
		const ffmpeg = resolveBinary("ffmpeg", opts.cwd, opts.ffmpeg ?? process.env.EIGHT_FFMPEG);
		const ffprobe = resolveBinary("ffprobe", opts.cwd, opts.ffprobe ?? process.env.EIGHT_FFPROBE);
		const anyAudio = frames.some((f) => f.wav);
		const tmpOut = path.join(work, "out.mp4");
		const r = await run(
			ffmpeg,
			buildFfmpegArgs(frames, tmpOut, anyAudio),
			Math.min(opts.timeoutMs ?? 180000, left()),
		);
		if (r.code !== 0 || !fs.existsSync(tmpOut))
			throw new Error(`ffmpeg failed: ${r.err.trim().split("\n").pop() ?? r.code}`);
		// Measured before it is placed, so a file that does not match the spec never lands in the project.
		const m = await probeMedia(tmpOut, ffprobe, Math.min(30000, left()));
		if (m.width !== W || m.height !== H)
			throw new Error(`ffmpeg wrote ${m.width}x${m.height}, not the ${W}x${H} the spec asks for`);
		if (anyAudio && m.audioSec === null)
			throw new Error("ffmpeg wrote no audio stream although slides carry narration");
		placeOutput(tmpOut, opts.out, opts.cwd);
		const chapters = chapterLines(spec.slides, starts);
		const chaptersTmp = path.join(work, "chapters.txt");
		fs.writeFileSync(chaptersTmp, `${chapters.join("\n")}\n`);
		assertChaptersWritable(chaptersPath);
		placeOutput(chaptersTmp, chaptersPath, opts.cwd);
		return {
			path: opts.out,
			...m,
			slides: spec.slides.length,
			hasAudio: m.audioSec !== null,
			kind: "video",
			starts,
			chapters,
			chaptersPath,
			durationLabel: clock(m.durationSec),
		};
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}
