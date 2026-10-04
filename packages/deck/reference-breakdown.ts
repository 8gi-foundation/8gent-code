/**
 * 8gent Code - measure a local reference video: cuts, shot lengths, look numbers.
 *
 * Step 1 of #3445. Off unless EIGHT_REF_BREAKDOWN=1. Local files only, no URLs,
 * no downloads. ffmpeg's scene filter finds the cuts; each shot is sampled at
 * three downscaled frames for brightness, contrast, dark ratio and up to four
 * dominant colours. Concept from edenfunf/reelmimic (MIT); no code taken from it.
 *
 * CLI: EIGHT_REF_BREAKDOWN=1 bun packages/deck/reference-breakdown.ts clip.mp4 [outDir]
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

type Env = Record<string, string | undefined>;
export interface Colour {
	hex: string;
	share: number;
}
export interface Shot {
	start: number;
	end: number;
	len: number;
	brightness: number;
	contrast: number;
	darkRatio: number;
	colours: Colour[];
}
export interface Breakdown {
	file: string;
	duration: number;
	avgShotLen: number;
	cutsPerMinute: number;
	shots: Shot[];
}

export const SCENE_THRESHOLD = 0.3;
const W = 48;
const H = 27;
const DARK_LUMA = 40;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function refBreakdownEnabled(env: Env = process.env): boolean {
	return env.EIGHT_REF_BREAKDOWN?.trim() === "1";
}

/** EIGHT_FFMPEG_PATH / EIGHT_FFPROBE_PATH, then PATH, then the usual install dirs. */
export function findMediaTool(name: "ffmpeg" | "ffprobe", env: Env = process.env): string | null {
	const override = env[`EIGHT_${name.toUpperCase()}_PATH`]?.trim();
	if (override) return existsSync(override) ? override : null;
	const dirs = [
		...(env.PATH ?? "").split(delimiter).filter(Boolean),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin",
	];
	return dirs.map((d) => join(d, name)).find((p) => existsSync(p)) ?? null;
}

function run(cmd: string, args: string[]): Promise<{ out: Buffer; err: string }> {
	return new Promise((ok, fail) => {
		execFile(
			cmd,
			args,
			{ encoding: "buffer", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
			(e, out, err) => {
				const tail = String(err).trim().split("\n").slice(-2).join(" ");
				if (e) fail(new Error(`${name(cmd)} failed: ${tail || e.message}`));
				else ok({ out, err: String(err) });
			},
		);
	});
}
const name = (p: string) => p.split("/").pop() ?? p;

/** Look numbers for raw rgb24 pixels: luma mean/std, dark share, top colours by 64-step bins. */
export function lookOf(
	rgb: Uint8Array,
): Pick<Shot, "brightness" | "contrast" | "darkRatio" | "colours"> {
	const n = Math.floor(rgb.length / 3);
	if (n === 0) return { brightness: 0, contrast: 0, darkRatio: 0, colours: [] };
	let sum = 0;
	let sq = 0;
	let dark = 0;
	const bins = new Map<number, [number, number, number, number]>();
	for (let i = 0; i < n; i++) {
		const r = rgb[i * 3];
		const g = rgb[i * 3 + 1];
		const b = rgb[i * 3 + 2];
		const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		sum += y;
		sq += y * y;
		if (y < DARK_LUMA) dark++;
		const key = ((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6);
		const bin = bins.get(key) ?? [0, 0, 0, 0];
		bin[0] += r;
		bin[1] += g;
		bin[2] += b;
		bin[3]++;
		bins.set(key, bin);
	}
	const mean = sum / n;
	const hex = (v: number) => Math.round(v).toString(16).padStart(2, "0");
	const colours = [...bins.values()]
		.sort((a, b) => b[3] - a[3])
		.slice(0, 4)
		.map(([r, g, b, c]) => ({ hex: `#${hex(r / c)}${hex(g / c)}${hex(b / c)}`, share: r3(c / n) }));
	return {
		brightness: r3(mean / 255),
		contrast: r3(Math.sqrt(Math.max(0, sq / n - mean * mean)) / 255),
		darkRatio: r3(dark / n),
		colours,
	};
}

export async function breakdown(videoPath: string, env: Env = process.env): Promise<Breakdown> {
	if (!refBreakdownEnabled(env))
		throw new Error("Reference breakdown is off. Set EIGHT_REF_BREAKDOWN=1 to use it.");
	if (/^[a-z][a-z0-9+.-]*:/i.test(videoPath))
		throw new Error(`Local files only, not a URL: ${videoPath}`);
	const file = resolve(videoPath);
	if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`No such video file: ${file}`);
	const ffmpeg = findMediaTool("ffmpeg", env);
	const ffprobe = findMediaTool("ffprobe", env);
	if (!ffmpeg || !ffprobe)
		throw new Error("ffmpeg and ffprobe are required (brew install ffmpeg).");

	let probe: { streams?: unknown[]; format?: { duration?: string } };
	try {
		const { out } = await run(ffprobe, [
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=codec_type:format=duration",
			"-of",
			"json",
			file,
		]);
		probe = JSON.parse(String(out));
	} catch {
		throw new Error(`Not a readable video file: ${file}`);
	}
	const duration = Number(probe.format?.duration);
	if (!probe.streams?.length || !Number.isFinite(duration) || duration <= 0)
		throw new Error(`Not a video file (no video stream): ${file}`);

	const { err } = await run(ffmpeg, [
		"-hide_banner",
		"-nostats",
		"-i",
		file,
		"-an",
		"-vf",
		`select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
		"-f",
		"null",
		"-",
	]);
	const cuts = [...err.matchAll(/Parsed_showinfo.*?pts_time:\s*([0-9.]+)/g)]
		.map((m) => Number(m[1]))
		.filter((t) => t > 0.05 && t < duration - 0.05);
	const edges = [0, ...cuts, duration];

	const shots: Shot[] = [];
	for (let i = 0; i < edges.length - 1; i++) {
		const start = edges[i];
		const end = edges[i + 1];
		const len = end - start;
		const frames: Buffer[] = [];
		for (const f of [0.25, 0.5, 0.75]) {
			const { out } = await run(ffmpeg, [
				"-v",
				"error",
				"-ss",
				(start + len * f).toFixed(3),
				"-i",
				file,
				"-frames:v",
				"1",
				"-vf",
				`scale=${W}:${H}`,
				"-f",
				"rawvideo",
				"-pix_fmt",
				"rgb24",
				"-",
			]);
			frames.push(out);
		}
		shots.push({
			start: r3(start),
			end: r3(end),
			len: r3(len),
			...lookOf(new Uint8Array(Buffer.concat(frames))),
		});
	}
	return {
		file,
		duration: r3(duration),
		avgShotLen: r3(duration / shots.length),
		cutsPerMinute: r3((cuts.length / duration) * 60),
		shots,
	};
}

/** One line per shot: index, span, length, look numbers, colours. */
export function shotTable(b: Breakdown): string {
	const head = `shots ${b.shots.length}  avg ${b.avgShotLen.toFixed(2)}s  cuts/min ${b.cutsPerMinute.toFixed(1)}  ${b.file}`;
	const rows = b.shots.map(
		(s, i) =>
			`${String(i + 1).padStart(3)}  ${s.start.toFixed(2)}-${s.end.toFixed(2)}  ${s.len.toFixed(2)}s  bright ${s.brightness.toFixed(2)}  contrast ${s.contrast.toFixed(2)}  dark ${s.darkRatio.toFixed(2)}  ${s.colours.map((c) => `${c.hex} ${Math.round(c.share * 100)}%`).join(" ")}`,
	);
	return `${[head, ...rows].join("\n")}\n`;
}

/** Writes report.json and style.txt into outDir; returns their paths. */
export function writeBreakdown(b: Breakdown, outDir: string): { report: string; table: string } {
	mkdirSync(outDir, { recursive: true });
	const report = join(outDir, "report.json");
	const table = join(outDir, "style.txt");
	writeFileSync(report, `${JSON.stringify(b, null, 2)}\n`);
	writeFileSync(table, shotTable(b));
	return { report, table };
}

if (import.meta.main) {
	const [video, outDir = "analysis"] = process.argv.slice(2);
	if (!video) {
		console.error("usage: bun packages/deck/reference-breakdown.ts <video> [outDir]");
		process.exit(2);
	}
	breakdown(video)
		.then((b) => {
			const p = writeBreakdown(b, outDir);
			process.stdout.write(shotTable(b));
			console.log(`wrote ${p.report}`);
		})
		.catch((e) => {
			console.error(String(e instanceof Error ? e.message : e));
			process.exit(1);
		});
}
