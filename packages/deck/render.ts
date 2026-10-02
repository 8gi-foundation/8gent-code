/**
 * 8gent Code - render a Marp deck to a narrated MP4.
 *
 * Deterministic path, no model anywhere in it:
 *   parse slides -> narration text -> HTML -> headless Chrome PNG (1920x1080)
 *   -> neural TTS WAV (Supertonic or KittenTTS, one batch for every slide)
 *   -> ffmpeg segment per slide -> concat -> deck.mp4
 *
 * The voice is cast from the one neural table in packages/voice/neural.ts,
 * strictly: a name that is not pinned there fails the render. There is no
 * system-voice path, and no fallback to the other neural engine either: the
 * fallback styles are other officers' voices, and a deck voice is identity.
 * Missing Chrome, ffmpeg, or the voice's pinned engine, or a slide that engine
 * could not voice, fails the render with a clear reason. A video is never
 * faked.
 *
 * CLI: bun packages/deck/render.ts deck/deck.md
 */

import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	NARRATOR,
	type NeuralDeps,
	NeuralTtsError,
	type SynthRequest,
	defaultDeps,
	findKittenPython,
	findSupertonic,
	resolveVoice,
	synthesizeBatch,
} from "../voice/neural";
import { slideHtml } from "./html";
import { type DeckSlide, parseDeck, slideNarration } from "./parse";

export const SLIDE_WIDTH = 1920;
export const SLIDE_HEIGHT = 1080;
export const FPS = 30;
/** Silence held after each slide's narration, seconds. */
export const SLIDE_PAD_SECONDS = 0.6;
/** No slide is shown for less than this, seconds. */
export const MIN_SLIDE_SECONDS = 2;

export interface DeckRenderResult {
	output: string;
	slides: number;
	seconds: number;
	voice: string;
}

export interface DeckRenderOptions {
	/** Output path. Default: the deck path with `.mp4`. */
	output?: string;
	/**
	 * Neural voice: a NEURAL_VOICE name, officer code or officer first name.
	 * Default: EIGHT_DECK_VOICE, else the narrator. Unpinned names fail.
	 */
	voice?: string;
	/** Machine access for the neural engines. Default: the real machine. */
	neural?: NeuralDeps;
	/** Chrome binary. Default: EIGHT_CHROME_PATH, else the first found. */
	chrome?: string;
	/** Keep the working directory (for inspection). Default false. */
	keepWorkDir?: boolean;
	/** Called with the work dir before cleanup. */
	onWorkDir?: (dir: string) => void;
}

const CHROME_CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

export function findChrome(env: Record<string, string | undefined> = process.env): string | null {
	const override = env.EIGHT_CHROME_PATH?.trim();
	if (override) return existsSync(override) ? override : null;
	return CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile(
			cmd,
			args,
			{ timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err) {
					const detail = String(stderr || err.message)
						.trim()
						.split("\n")
						.slice(-3)
						.join(" ");
					reject(new Error(`${basename(cmd)} failed: ${detail}`));
				} else resolvePromise(String(stdout));
			},
		);
	});
}

async function hasCommand(cmd: string): Promise<boolean> {
	try {
		await run("/usr/bin/which", [cmd], 5000);
		return true;
	} catch {
		return false;
	}
}

/**
 * The narration voice as a NEURAL_VOICE table name: explicit, then
 * EIGHT_DECK_VOICE, then the narrator. Strict: an unpinned name throws
 * NeuralTtsError("unpinned_voice") rather than quietly becoming someone else.
 */
export function resolveDeckVoice(
	explicit?: string,
	env: Record<string, string | undefined> = process.env,
): string {
	const chosen = explicit?.trim() || env.EIGHT_DECK_VOICE?.trim() || NARRATOR;
	const r = resolveVoice(chosen, { strict: true });
	if (!r.ok) throw r.error;
	return r.voice.name;
}

/**
 * Fails before any work when the voice's pinned engine is not installed. The
 * deck never falls back to the other engine, so the other one does not count.
 */
export function checkNeuralEngines(deps: NeuralDeps, voice: string = NARRATOR): void {
	const r = resolveVoice(voice, { strict: true });
	if (!r.ok) throw r.error;
	const { engine, style } = r.voice;
	if (engine === "supertonic" ? findSupertonic(deps) : findKittenPython(deps)) return;
	const fix =
		engine === "supertonic"
			? "install Supertonic or set EIGHT_SUPERTONIC_BIN"
			: "install KittenTTS or set EIGHT_TTS_PYTHON";
	throw new NeuralTtsError(
		"no_engine",
		`no neural TTS engine found for voice "${r.voice.name}" (pinned to ${engine} ${style}; ${fix})`,
	);
}

/**
 * Voice every slide in one synthesizeBatch call, so KittenTTS loads its
 * model once per deck. Returns the WAV path per slide, in slide order.
 * Strict, no fallback: any slide its pinned engine could not voice throws
 * its NeuralTtsError ("engine_failed"), naming the slide and the attempt.
 */
export async function narrateSlides(
	slides: DeckSlide[],
	voice: string,
	work: string,
	deps: NeuralDeps,
): Promise<string[]> {
	const reqs: SynthRequest[] = slides.map((slide) => ({
		text: narrationFor(slide, slides.length),
		voice,
		outPath: join(work, `slide-${String(slide.index).padStart(3, "0")}.wav`),
		strict: true,
	}));
	const results = await synthesizeBatch(reqs, deps);
	const paths: string[] = [];
	results.forEach((r, i) => {
		if (!r.ok) {
			const tried = r.error.attempts
				.map((a) => `${a.engine} ${a.style}: ${a.reason ?? "failed"}`)
				.join("; ");
			throw new NeuralTtsError(
				r.error.code,
				`slide ${slides[i].index}: ${r.error.message}${tried ? ` (${tried})` : ""}`,
				r.error.attempts,
			);
		}
		paths.push(r.path);
	});
	return paths;
}

/** ffmpeg args for one slide: still image held for the audio plus padding. */
export function segmentArgs(
	image: string,
	audio: string,
	seconds: number,
	output: string,
): string[] {
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-loop",
		"1",
		"-framerate",
		String(FPS),
		"-i",
		image,
		"-i",
		audio,
		"-filter_complex",
		`[0:v]scale=${SLIDE_WIDTH}:${SLIDE_HEIGHT},format=yuv420p[v];[1:a]aresample=48000,apad[a]`,
		"-map",
		"[v]",
		"-map",
		"[a]",
		"-t",
		seconds.toFixed(3),
		"-r",
		String(FPS),
		"-c:v",
		"libx264",
		"-preset",
		"medium",
		"-tune",
		"stillimage",
		"-crf",
		"20",
		"-threads",
		"1",
		"-c:a",
		"aac",
		"-b:a",
		"160k",
		"-ac",
		"2",
		"-ar",
		"48000",
		"-fflags",
		"+bitexact",
		"-flags:v",
		"+bitexact",
		"-flags:a",
		"+bitexact",
		"-map_metadata",
		"-1",
		output,
	];
}

/** ffmpeg args to join the per-slide segments listed in `listFile`. */
export function concatArgs(listFile: string, output: string): string[] {
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"concat",
		"-safe",
		"0",
		"-i",
		listFile,
		"-c",
		"copy",
		"-movflags",
		"+faststart",
		"-fflags",
		"+bitexact",
		"-map_metadata",
		"-1",
		output,
	];
}

/** Line for an ffmpeg concat list; single quotes escaped the way ffmpeg expects. */
export function concatListLine(path: string): string {
	return `file '${path.replace(/'/g, "'\\''")}'`;
}

/** How long a slide is held: narration plus pad, never below the minimum. */
export function slideSeconds(audioSeconds: number): number {
	return Math.max(MIN_SLIDE_SECONDS, Math.round((audioSeconds + SLIDE_PAD_SECONDS) * 1000) / 1000);
}

export async function probeDuration(file: string): Promise<number> {
	const out = await run(
		"ffprobe",
		["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
		30_000,
	);
	const n = Number.parseFloat(out.trim());
	if (!Number.isFinite(n)) throw new Error(`ffprobe could not read the duration of ${file}`);
	return n;
}

/**
 * Headless Chrome screenshot of one HTML page.
 *
 * Chrome writes the PNG and prints "N bytes written to file", but on recent
 * macOS builds the process can then stay alive (updater and display-link
 * threads). So we watch stderr for that line, then end the process group we
 * started ourselves. Only our own child is signalled, never a name match.
 */
export function chromeArgs(html: string, png: string, profile: string): string[] {
	return [
		"--headless=new",
		"--disable-gpu",
		"--hide-scrollbars",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--disable-background-networking",
		"--disable-component-update",
		"--disable-sync",
		"--disable-breakpad",
		"--no-service-autorun",
		"--mute-audio",
		"--force-device-scale-factor=1",
		`--user-data-dir=${profile}`,
		`--window-size=${SLIDE_WIDTH},${SLIDE_HEIGHT}`,
		`--screenshot=${png}`,
		pathToFileURL(html).href,
	];
}

function screenshot(chrome: string, html: string, png: string, profile: string): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(chrome, chromeArgs(html, png, profile), {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let log = "";
		let settled = false;
		const stop = () => {
			if (child.pid === undefined || child.exitCode !== null) return;
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				// Already gone.
			}
			const hard = setTimeout(() => {
				try {
					if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}, 3000);
			hard.unref();
		};
		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			stop();
			if (err) reject(err);
			else resolvePromise();
		};
		const timer = setTimeout(
			() => finish(new Error("headless Chrome timed out taking a screenshot")),
			60_000,
		);
		const onData = (chunk: Buffer) => {
			log = (log + chunk.toString()).slice(-4000);
			if (/bytes written to file/.test(log) && existsSync(png)) finish();
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.on("error", (err) => finish(new Error(`could not start Chrome: ${err.message}`)));
		child.on("exit", () => {
			if (existsSync(png)) finish();
			else finish(new Error("headless Chrome exited without a screenshot"));
		});
	});
}

/** Narration text per slide, falling back to the slide number when a slide has no words. */
export function narrationFor(slide: DeckSlide, total: number): string {
	return slideNarration(slide) || `Slide ${slide.index} of ${total}.`;
}

export async function renderDeckVideo(
	deckPath: string,
	options: DeckRenderOptions = {},
): Promise<DeckRenderResult> {
	const source = resolve(deckPath);
	const markdown = await readFile(source, "utf-8");
	const { slides } = parseDeck(markdown);
	if (slides.length === 0) throw new Error("deck has no slides");

	// Voice and engines first: both are cheap, and neither needs a spawn.
	const voice = resolveDeckVoice(options.voice);
	const neural = options.neural ?? defaultDeps();
	checkNeuralEngines(neural, voice);
	const chrome = options.chrome ?? findChrome();
	if (!chrome) {
		throw new Error("no Chrome or Chromium found (install Google Chrome or set EIGHT_CHROME_PATH)");
	}
	for (const cmd of ["ffmpeg", "ffprobe"]) {
		if (!(await hasCommand(cmd))) throw new Error(`${cmd} not found on PATH`);
	}
	const output =
		options.output ?? join(dirname(source), `${basename(source, extname(source))}.mp4`);

	const work = mkdtempSync(join(tmpdir(), "8gent-deck-"));
	try {
		const profile = join(work, "chrome-profile");
		const pngs: string[] = [];
		for (const slide of slides) {
			const n = String(slide.index).padStart(3, "0");
			const html = join(work, `slide-${n}.html`);
			const png = join(work, `slide-${n}.png`);
			writeFileSync(html, slideHtml(slide, slides.length));
			await screenshot(chrome, html, png, profile);
			pngs.push(png);
		}
		const wavs = await narrateSlides(slides, voice, work, neural);
		const segments: string[] = [];
		for (const [i, slide] of slides.entries()) {
			const seg = join(work, `slide-${String(slide.index).padStart(3, "0")}.mp4`);
			const seconds = slideSeconds(await probeDuration(wavs[i]));
			await run("ffmpeg", segmentArgs(pngs[i], wavs[i], seconds, seg), 180_000);
			segments.push(seg);
		}
		const list = join(work, "segments.txt");
		writeFileSync(list, `${segments.map(concatListLine).join("\n")}\n`);
		const partial = join(work, "deck.mp4");
		await run("ffmpeg", concatArgs(list, partial), 180_000);
		// Rename is atomic on one volume; across volumes fall back to copy.
		try {
			renameSync(partial, output);
		} catch {
			copyFileSync(partial, output);
		}
		const seconds = Math.round(await probeDuration(output));
		options.onWorkDir?.(work);
		return { output, slides: slides.length, seconds, voice };
	} finally {
		if (!options.keepWorkDir) rmSync(work, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const keep = args.includes("--keep");
	const deck = args.find((a) => !a.startsWith("--"));
	if (!deck) {
		console.error("usage: bun packages/deck/render.ts <deck.md> [--keep]");
		process.exit(2);
	}
	renderDeckVideo(deck, {
		keepWorkDir: keep,
		onWorkDir: keep ? (d) => console.log(`work dir: ${d}`) : undefined,
	})
		.then((r) => {
			console.log(`rendered ${r.output}: ${r.slides} slides, ${r.seconds}s, voice ${r.voice}`);
		})
		.catch((err: Error) => {
			console.error(`deck video not rendered: ${err.message}`);
			process.exit(1);
		});
}
