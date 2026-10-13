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
}

const COLORS = {
	bg: "#14110e",
	panel: "#1f1a15",
	ink: "#f3ece2",
	muted: "#b7a993",
	amber: "#e3a53c",
	line: "#3a3128",
};

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

/** True when the path is inside root after following links. Images are the only reads. */
function readInside(named: string, cwd: string): Buffer {
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

/** Paint one slide to PNG bytes. Pure function of (slide, size, image bytes). */
export async function paintSlide(
	slide: DeckSlide,
	size: keyof typeof SIZES,
	cwd: string,
	deckTitle?: string,
): Promise<Buffer> {
	const { createCanvas, loadImage } = await import("@napi-rs/canvas");
	const [W, H] = SIZES[size];
	const k = W / 1280;
	const canvas = createCanvas(W, H);
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = COLORS.bg;
	ctx.fillRect(0, 0, W, H);
	const x = 80 * k;
	let y = 70 * k;
	const hasImage = Boolean(slide.image);
	const textW = (hasImage ? 640 : 1120) * k;
	const sans = (px: number, bold = false) =>
		`${bold ? "bold " : ""}${Math.round(px * k)}px sans-serif`;

	if (slide.kicker) {
		ctx.fillStyle = COLORS.amber;
		ctx.font = sans(22, true);
		ctx.fillText(slide.kicker.toUpperCase(), x, y + 22 * k);
		y += 56 * k;
	}
	if (slide.title) {
		ctx.fillStyle = COLORS.ink;
		ctx.font = sans(56, true);
		for (const ln of wrap(ctx, slide.title, textW)) {
			ctx.fillText(ln, x, y + 50 * k);
			y += 66 * k;
		}
		y += 20 * k;
	}
	if (slide.text) {
		ctx.fillStyle = COLORS.muted;
		ctx.font = sans(30);
		for (const ln of wrap(ctx, slide.text, textW)) {
			ctx.fillText(ln, x, y + 30 * k);
			y += 44 * k;
		}
		y += 16 * k;
	}
	for (const b of slide.bullets ?? []) {
		ctx.font = sans(28);
		const lines = wrap(ctx, b, textW - 40 * k);
		ctx.fillStyle = COLORS.amber;
		ctx.beginPath();
		ctx.arc(x + 8 * k, y + 18 * k, 7 * k, 0, Math.PI * 2);
		ctx.fill();
		ctx.fillStyle = COLORS.ink;
		for (const ln of lines) {
			ctx.fillText(ln, x + 40 * k, y + 28 * k);
			y += 40 * k;
		}
		y += 12 * k;
		ctx.fillStyle = COLORS.line;
		ctx.fillRect(x, y, textW, 1);
		y += 12 * k;
	}
	if (slide.image) {
		const img = await loadImage(readInside(slide.image, cwd));
		const bx = 760 * k;
		const by = 90 * k;
		const bw = 440 * k;
		const bh = H - 180 * k;
		const s = Math.min(bw / img.width, bh / img.height);
		const w = Math.round(img.width * s);
		const h = Math.round(img.height * s);
		ctx.fillStyle = COLORS.panel;
		ctx.fillRect(bx, by, bw, bh);
		ctx.drawImage(img, bx + Math.round((bw - w) / 2), by + Math.round((bh - h) / 2), w, h);
	}
	if (deckTitle) {
		ctx.fillStyle = COLORS.muted;
		ctx.font = sans(18);
		ctx.fillText(deckTitle, x, H - 36 * k);
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

/** The exact ffmpeg argv for a deck. Exported so tests can assert it is network-free. */
export function buildFfmpegArgs(
	frames: { png: string; sec: number; wav?: string }[],
	out: string,
	anyAudio: boolean,
): string[] {
	const args = ["-y", "-hide_banner", "-loglevel", "error", "-nostdin"];
	const wavIndex: Record<number, number> = {};
	let n = 0;
	for (const f of frames) {
		args.push(
			"-protocol_whitelist",
			"file",
			"-loop",
			"1",
			"-framerate",
			String(FPS),
			"-t",
			f.sec.toFixed(3),
			"-i",
			f.png,
		);
		n++;
	}
	frames.forEach((f, i) => {
		if (f.wav) {
			args.push("-protocol_whitelist", "file", "-i", f.wav);
			wavIndex[i] = n++;
		}
	});
	const parts: string[] = [];
	const labels: string[] = [];
	frames.forEach((f, i) => {
		parts.push(`[${i}:v]format=yuv420p,setsar=1,fps=${FPS}[v${i}]`);
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
		const frames: { png: string; sec: number; wav?: string }[] = [];
		let total = 0;
		for (let i = 0; i < spec.slides.length; i++) {
			const s = spec.slides[i];
			const png = path.join(work, `slide-${String(i).padStart(3, "0")}.png`);
			fs.writeFileSync(png, await paintSlide(s, spec.size, opts.cwd, spec.title));
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
			total += fixed;
			if (total > MAX_TOTAL_SECONDS)
				throw new Error(`deck is over ${MAX_TOTAL_SECONDS}s once narration is counted`);
			frames.push({ png, sec: fixed, wav });
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
		return {
			path: opts.out,
			...m,
			slides: spec.slides.length,
			hasAudio: m.audioSec !== null,
			kind: "video",
		};
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}
