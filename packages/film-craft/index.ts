/**
 * @8gent/film-craft: the 8GI film look as data, plus the recipe that applies it.
 * A film preset names a palette, type scale, title card, lower third, grade, camera move, transition, pacing
 * and music bed (presets.json). planFilm() turns slide texts and durations into magick + ffmpeg commands
 * (no drawtext needed); mixPresets() takes the grade of one film and the titles of another.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type BedSpec, generateBed } from "./bed";
import presets from "./presets.json";

export { generateBed, type BedSpec } from "./bed";
type Palette = {
	bgTop: string;
	bgBottom: string;
	fog: string;
	ink: string;
	ink2: string;
	dim: string;
	accent: string;
	accentCore: string;
};
type TypeScale = {
	display: string[];
	label: string[];
	body: string[];
	sizes: Record<"kicker" | "title" | "sub" | "lower" | "caption", number>;
	kickerTracking: number;
	uppercaseKicker: boolean;
};
type TitleCard = {
	align: "center" | "left";
	kickerY: number;
	titleY: number;
	subGap: number;
	maxTitleWidth: number;
	glow: { x: number; y: number; radius: number; strength: number };
	motes: number;
};
type LowerThird = { y: number; x: number; ruleWidth: number; ruleHeight: number; scrim: number };
type Grade = {
	bloom: { opacity: number; sigma: number; downscale: number };
	balance: string;
	eq: string;
	vignette: number;
	grain: number;
};
type Camera = { zoomFrom: number; zoomTo: number; panX: number; panY: number };
type Transition = { xfade: string; seconds: number };
type Pacing = { bpm: number; textIn: number; textBlur: number; minHold: number };
type FilmRef = Record<
	| "palette"
	| "typeScale"
	| "titleCard"
	| "lowerThird"
	| "grade"
	| "camera"
	| "transition"
	| "pacing"
	| "bed",
	string
> & { description: string };
export type Catalog = {
	palettes: Record<string, Palette>;
	typeScales: Record<string, TypeScale>;
	titleCards: Record<string, TitleCard>;
	lowerThirds: Record<string, LowerThird>;
	grades: Record<string, Grade>;
	cameras: Record<string, Camera>;
	transitions: Record<string, Transition>;
	pacing: Record<string, Pacing>;
	beds: Record<string, BedSpec>;
	films: Record<string, FilmRef>;
};
export type Preset = {
	name: string;
	description: string;
	palette: Palette;
	typeScale: TypeScale;
	titleCard: TitleCard;
	lowerThird: LowerThird;
	grade: Grade;
	camera: Camera;
	transition: Transition;
	pacing: Pacing;
	bed: BedSpec;
	bedId: string;
};
export type Slide = {
	title: string;
	kicker?: string;
	sub?: string;
	lower?: string;
	seconds: number;
};

export const CATALOG = presets as unknown as Catalog;

/** False for any saturated colour with a hue in 270-350 (the banned purple/pink/violet band). */
export function hueOk(hex: string): boolean {
	const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
	const mx = Math.max(r, g, b);
	const d = mx - Math.min(r, g, b);
	if (mx === 0 || d / mx < 0.15) return true;
	const h = (mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
	return !(h >= 270 && h <= 350);
}

export function resolvePreset(name: string): Preset {
	const f = CATALOG.films[name];
	if (!f)
		throw new Error(`unknown preset '${name}'. Known: ${Object.keys(CATALOG.films).join(", ")}`);
	const pick = <T>(table: Record<string, T>, id: string, what: string) => {
		const v = table[id];
		if (!v) throw new Error(`preset '${name}' names missing ${what} '${id}'`);
		return v;
	};
	return {
		name,
		description: f.description,
		palette: pick(CATALOG.palettes, f.palette, "palette"),
		typeScale: pick(CATALOG.typeScales, f.typeScale, "typeScale"),
		titleCard: pick(CATALOG.titleCards, f.titleCard, "titleCard"),
		lowerThird: pick(CATALOG.lowerThirds, f.lowerThird, "lowerThird"),
		grade: pick(CATALOG.grades, f.grade, "grade"),
		camera: pick(CATALOG.cameras, f.camera, "camera"),
		transition: pick(CATALOG.transitions, f.transition, "transition"),
		pacing: pick(CATALOG.pacing, f.pacing, "pacing"),
		bed: pick(CATALOG.beds, f.bed, "bed"),
		bedId: f.bed,
	};
}

/** The grade, camera and cuts of `gradeFrom`; the palette, type, title card, pacing and bed of `titlesFrom`. */
export function mixPresets(gradeFrom: string, titlesFrom: string): Preset {
	const g = resolvePreset(gradeFrom);
	const t = resolvePreset(titlesFrom);
	return {
		...t,
		name: `${gradeFrom}+${titlesFrom}`,
		description: `grade of ${gradeFrom}, titles of ${titlesFrom}`,
		grade: g.grade,
		camera: g.camera,
		transition: g.transition,
	};
}

export const listPresets = () =>
	Object.entries(CATALOG.films).map(([name, f]) => ({ name, description: f.description }));

let fontList: string | undefined;
export function defaultFontResolver(cands: string[]): string | undefined {
	for (const c of cands) {
		const p = c.startsWith("~") ? join(homedir(), c.slice(1)) : c;
		if (p.startsWith("/")) {
			if (existsSync(p)) return p;
			continue;
		}
		fontList ??= spawnSync("magick", ["-list", "font"], { encoding: "utf8" }).stdout ?? "";
		if (fontList.includes(`Font: ${c}\n`)) return c;
	}
	return undefined;
}

const q = (s: string | number) => `'${String(s).replace(/'/g, "'\\''")}'`;
const txt = (s: string) => q(s.replace(/%/g, "%%").replace(/^@/, " @"));
const r1 = (x: number) => Math.round(x);
function motes(seed: number, count: number, W: number, H: number, color: string): string {
	let a = seed * 9973 + 17;
	const u = () => (a = (a * 16807) % 2147483647) / 2147483647;
	const dots = Array.from({ length: count }, () => {
		const x = r1(u() * W);
		const y = r1(u() * H);
		return `-draw ${q(`circle ${x},${y} ${x},${y + 1 + r1(u() * 4)}`)}`;
	});
	return `\\( -size ${W}x${H} xc:none -fill ${q(`${color}66`)} ${dots.join(" ")} -blur 0x2 \\) -compose screen -composite`;
}

/** One slide as a magick command. soft=true draws the text blurred and faint: the frame it resolves from. */
function slideCommand(
	P: Preset,
	s: Slide,
	i: number,
	W: number,
	H: number,
	out: string,
	soft: boolean,
	font: (c: string[]) => string | undefined,
): string {
	const { palette: c, typeScale: ts, titleCard: tc, lowerThird: lt } = P;
	const S = Math.min(W, H);
	const dark = Number.parseInt(c.bgTop.slice(1, 3), 16) < 128;
	const f = (cands: string[]) => {
		const v = font(cands);
		return v ? `-font ${q(v)}` : "";
	};
	const left = tc.align === "left";
	const x0 = left ? r1(W * 0.08) : 0;
	const grav = left ? "northwest" : "north";
	const gr = r1(tc.glow.radius * S);
	const layers: string[] = [
		`magick -size ${W}x${H} gradient:${q(`${c.bgTop}-${c.bgBottom}`)}`,
		`\\( -size ${W}x${H} radial-gradient:${q(`${c.fog}-${c.bgTop}`)} \\) -compose ${dark ? "lighten" : "darken"} -composite`,
	];
	if (dark) {
		// The light moves between shots, so every cut is a new composition, not the same frame with new words.
		const dx = [0, -0.2, 0.18, -0.12, 0.14][i % 5];
		const dy = [0, 0.06, -0.05, 0.08, -0.03][i % 5];
		const gx = r1(Math.min(0.9, Math.max(0.1, tc.glow.x + dx)) * W);
		const gy = r1(Math.min(0.9, Math.max(0.1, tc.glow.y + dy)) * H);
		layers.push(
			`\\( -size ${W}x${H} xc:black -fill ${q(c.accentCore)} -draw ${q(`circle ${gx},${gy} ${gx + gr},${gy}`)} -blur 0x${r1(gr * 0.9)} -fill ${q("#FFF2D0")} -draw ${q(`circle ${gx},${gy} ${gx + r1(gr * 0.16)},${gy}`)} -blur 0x${Math.max(1, r1(gr * 0.12))} -evaluate multiply ${tc.glow.strength} \\) -compose screen -composite`,
		);
		layers.push(motes(i + 1, tc.motes, W, H, c.accent));
	}
	const text: string[] = [];
	const add = (img: string, y: number, x = x0) =>
		text.push(
			`-gravity ${grav} \\( -background none ${img} \\) -gravity ${grav} -geometry +${x}+${r1(y * H)} -compose over -composite`,
		);
	const maxW = r1(W * tc.maxTitleWidth);
	const align = left ? "west" : "center";
	if (s.kicker)
		add(
			`-fill ${q(c.accent)} ${f(ts.label)} -pointsize ${r1(ts.sizes.kicker * S)} -kerning ${ts.kickerTracking} +size label:${txt(ts.uppercaseKicker ? s.kicker.toUpperCase() : s.kicker)}`,
			tc.kickerY,
		);
	// Title and sub are stacked in one image so a title that wraps pushes the sub down instead of overlapping it.
	const title = `-fill ${q(c.ink)} ${f(ts.display)} -pointsize ${r1(ts.sizes.title * S)} -kerning 0 -gravity ${align} -size ${maxW}x caption:${txt(s.title)}`;
	const sub = s.sub
		? ` \\( -size 1x${r1(tc.subGap * H)} xc:none \\) -fill ${q(c.ink2)} ${f(ts.body)} -pointsize ${r1(ts.sizes.sub * S)} -kerning 0 -gravity ${align} -size ${maxW}x caption:${txt(s.sub)} -background none -gravity ${align} -append`
		: "";
	add(title + sub, tc.titleY);
	if (left)
		text.push(
			`-fill ${q(c.accent)} -draw ${q(`rectangle ${x0},${r1(tc.kickerY * H) - r1(S * 0.03)} ${x0 + r1(S * 0.06)},${r1(tc.kickerY * H) - r1(S * 0.025)}`)}`,
		);
	if (s.lower) {
		const ly = r1(lt.y * H);
		const lx = lt.ruleWidth ? r1(lt.x * W) : 0;
		layers.push(
			`\\( -size ${W}x${H - ly + r1(S * 0.06)} gradient:${q(`${c.bgBottom}00-${c.bgBottom}`)} -channel A -evaluate multiply ${lt.scrim} +channel \\) -gravity south -compose over -composite -gravity northwest`,
		);
		if (lt.ruleWidth)
			text.push(
				`-fill ${q(c.accent)} -draw ${q(`rectangle ${lx},${ly} ${lx + r1(lt.ruleWidth * W)},${ly + Math.max(2, r1(lt.ruleHeight * H))}`)}`,
			);
		text.push(
			`-gravity ${lt.ruleWidth ? "northwest" : "north"} \\( -background none -fill ${q(c.ink)} ${f(ts.body)} -pointsize ${r1(ts.sizes.lower * S)} -kerning 0 +size label:${txt(s.lower)} \\) -gravity ${lt.ruleWidth ? "northwest" : "north"} -geometry +${lx}+${ly + r1(S * 0.02)} -compose over -composite`,
		);
	}
	const textGroup = soft
		? `\\( -size ${W}x${H} xc:none ${text.join(" ")} -blur 0x${P.pacing.textBlur} -channel A -evaluate multiply 0.3 +channel \\) -gravity northwest -geometry +0+0 -compose over -composite`
		: text.join(" ");
	return `${layers.join(" ")} -gravity northwest ${textGroup} -flatten ${q(out)}`;
}

export type PlanInput = {
	slides: Slide[];
	preset: string | Preset;
	outDir: string;
	out?: string;
	width?: number;
	height?: number;
	fps?: number;
	narration?: string;
	bed?: string;
	resolveFont?: (c: string[]) => string | undefined;
};
export type Plan = {
	preset: string;
	total: number;
	hits: number[];
	commands: string[];
	script: string;
	output: string;
	/** Every path film.sh writes (frames, shots, picture, output), for a caller that confines writes. */
	writes: string[];
};

function intIn(v: unknown, dflt: number, lo: number, hi: number, what: string): number {
	if (v === undefined || v === null) return dflt;
	if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi)
		throw new Error(`${what} must be an integer from ${lo} to ${hi} (got ${JSON.stringify(v)})`);
	return v;
}

const hasDotDot = (p: string) => p.split(/[\\/]/).includes("..");

export function planFilm(o: PlanInput): Plan {
	const P = typeof o.preset === "string" ? resolvePreset(o.preset) : o.preset;
	// Numbers go into film.sh unquoted, so only real integers in range are accepted.
	const W = intIn(o.width, 1280, 16, 7680, "width");
	const H = intIn(o.height, 720, 16, 7680, "height");
	const fps = intIn(o.fps, 24, 1, 120, "fps");
	const font = o.resolveFont ?? defaultFontResolver;
	if (!o.slides?.length) throw new Error("plan needs at least one slide");
	for (const s of o.slides)
		if (!(Number.isFinite(s.seconds) && s.seconds > 0) || !s.title?.trim())
			throw new Error("every slide needs a title and finite seconds > 0");
	const name = o.out ?? "film.mp4";
	if (basename(name) !== name || name === ".." || !name.endsWith(".mp4"))
		throw new Error(`out must be a bare .mp4 file name inside out_dir, not a path ("${name}")`);
	for (const p of [o.outDir, o.narration, o.bed])
		if (p && hasDotDot(p)) throw new Error(`paths in film.sh may not contain ".." ("${p}")`);
	const n = o.slides.length;
	const x = Math.min(P.transition.seconds, ...o.slides.map((s) => s.seconds / 2));
	const dir = o.outDir;
	const out = join(dir, name);
	const pic = join(dir, "film-picture.mp4");
	const cmds: string[] = [`mkdir -p ${q(join(dir, "frames"))}`, "pids=()"];
	const writes: string[] = [dir, join(dir, "frames"), pic, out];
	const graph: string[] = [];
	const clips: string[] = [];
	const hits: number[] = [];
	let acc = 0;
	o.slides.forEach((s, i) => {
		// One background job per slide: draw it soft and sharp, then shoot it (text blur-in, camera move).
		const soft = join(dir, "frames", `slide-${i + 1}-soft.png`);
		const sharp = join(dir, "frames", `slide-${i + 1}.png`);
		const clip = join(dir, "frames", `shot-${i + 1}.mp4`);
		writes.push(soft, sharp, clip);
		const L = s.seconds + (i < n - 1 ? x : 0);
		const frames = Math.max(2, Math.round(L * fps));
		const tIn = Math.min(P.pacing.textIn, s.seconds / 3);
		const { zoomFrom: zf, zoomTo: zt, panX, panY } = P.camera;
		const k = `(on/${frames - 1})`;
		const z = `(${zf}+${(zt - zf).toFixed(4)}*${k})`;
		const shot = `[0:v][1:v]xfade=transition=fade:duration=${tIn.toFixed(3)}:offset=${Math.min(x * 0.5, s.seconds / 4).toFixed(3)},scale=${W * 2}:${H * 2}:flags=lanczos,zoompan=z='${z}':x='(iw-iw/zoom)/2*(1+${panX}*${k})':y='(ih-ih/zoom)/2*(1+${panY}*${k})':d=1:s=${W}x${H}:fps=${fps},setsar=1,format=yuv420p`;
		const loop = (png: string) => `-loop 1 -framerate ${fps} -t ${L.toFixed(3)} -i ${q(png)}`;
		cmds.push(
			`( ${slideCommand(P, s, i, W, H, soft, true, font)} && ${slideCommand(P, s, i, W, H, sharp, false, font)} && ffmpeg -y -v error ${loop(soft)} ${loop(sharp)} -filter_complex ${q(shot)} -frames:v ${Math.round(L * fps)} -c:v libx264 -preset veryfast -crf 18 ${q(clip)} ) & pids+=($!)`,
		);
		clips.push(`-i ${q(clip)}`);
		if (i > 0) hits.push(Number(acc.toFixed(3)));
		acc += s.seconds;
	});
	cmds.push('for p in "${pids[@]}"; do wait "$p"; done');
	let last = "0:v";
	for (let i = 1; i < n; i++) {
		graph.push(
			`[${last}][${i}:v]xfade=transition=${P.transition.xfade}:duration=${x.toFixed(3)}:offset=${hits[i - 1].toFixed(3)}[x${i}]`,
		);
		last = `x${i}`;
	}
	const G = P.grade;
	const bl = G.bloom;
	// Grade in RGB: a screen blend on YUV planes lifts chroma and turns the frame magenta.
	graph.push(
		bl.opacity > 0
			? `[${last}]format=gbrp,split[ga][gb];[gb]scale=${r1(W / bl.downscale)}:${r1(H / bl.downscale)},gblur=sigma=${bl.sigma},scale=${W}:${H}[gg];[ga][gg]blend=all_mode=screen:all_opacity=${bl.opacity}[gl]`
			: `[${last}]format=gbrp[gl]`,
	);
	graph.push(
		`[gl]colorbalance=${G.balance},eq=${G.eq},vignette=angle=${G.vignette},noise=c0s=${G.grain}:c0f=t+u,format=yuv420p[v]`,
	);
	cmds.push(
		`ffmpeg -y -v error ${clips.join(" ")} -filter_complex ${q(graph.join(";"))} -map '[v]' -c:v libx264 -preset fast -crf 18 -r ${fps} -t ${acc.toFixed(3)} ${q(pic)}`,
	);
	const T = acc.toFixed(3);
	const fadeOut = `afade=t=out:st=${Math.max(0, acc - 1.5).toFixed(3)}:d=1.5`;
	if (o.narration && o.bed)
		cmds.push(
			`ffmpeg -y -v error -i ${q(pic)} -i ${q(o.narration)} -i ${q(o.bed)} -filter_complex ${q(`[1:a]aresample=48000,apad,asplit[vo][sc];[2:a]aresample=48000,volume=0.22[b];[b][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[d];[vo][d]amix=inputs=2:duration=first:normalize=0,atrim=duration=${T},${fadeOut}[a]`)} -map 0:v -map '[a]' -c:v copy -c:a aac -b:a 192k -t ${T} ${q(out)}`,
		);
	else if (o.narration || o.bed)
		cmds.push(
			`ffmpeg -y -v error -i ${q(pic)} -i ${q((o.narration ?? o.bed) as string)} -filter_complex ${q(`[1:a]aresample=48000,apad,atrim=duration=${T},${fadeOut}[a]`)} -map 0:v -map '[a]' -c:v copy -c:a aac -b:a 192k -t ${T} ${q(out)}`,
		);
	else cmds.push(`mv ${q(pic)} ${q(out)}`);
	return {
		preset: P.name,
		total: acc,
		hits,
		commands: cmds,
		script: `#!/bin/bash\n# film_craft preset ${P.name}: ${n} slides, ${T} s\nset -euo pipefail\n${cmds.join("\n")}\n`,
		output: out,
		writes,
	};
}

/**
 * Confines what the tool touches. write() and read() take a path as the model gave it and return the
 * absolute path to use, or throw. Without a guard (library use) paths are used as given.
 */
export type FilmCraftGuard = { write(p: string): string; read(p: string): string };
const OPEN: FilmCraftGuard = { write: (p) => p, read: (p) => p };

/** The film_craft tool: list | plan | bed | mix. Returns text for the model; never throws. */
export async function filmCraft(
	a: Record<string, unknown>,
	guard: FilmCraftGuard = OPEN,
): Promise<string> {
	try {
		const preset = (a.preset as string) ?? "lotus-night";
		const P = a.grade_from ? mixPresets(a.grade_from as string, preset) : resolvePreset(preset);
		switch (a.action) {
			case "list":
				return listPresets()
					.map((p) => `${p.name}: ${p.description}`)
					.join("\n");
			case "mix":
				return JSON.stringify(P, null, 2);
			case "bed": {
				const wav = guard.write(String(a.out ?? join(String(a.out_dir ?? "video"), "bed.wav")));
				if (!wav.endsWith(".wav")) throw new Error(`bed out must end in .wav ("${wav}")`);
				mkdirSync(dirname(wav), { recursive: true });
				const r = generateBed({
					seconds: Number(a.seconds),
					out: wav,
					hits: typeof a.hits === "string" ? JSON.parse(a.hits) : ((a.hits as number[]) ?? []),
					bed: P.bed,
				});
				return `Wrote ${r.path}: ${r.seconds} s original bed in ${r.key}, peak ${r.peakDb.toFixed(1)} dBFS, rms ${r.rmsDb.toFixed(1)} dBFS.`;
			}
			case "plan": {
				const slides = (typeof a.slides === "string" ? JSON.parse(a.slides) : a.slides) as Slide[];
				const dir = guard.write(String(a.out_dir ?? "video"));
				const p = planFilm({
					slides,
					preset: P,
					outDir: dir,
					out: a.out as string | undefined,
					width: a.width as number | undefined,
					height: a.height as number | undefined,
					fps: a.fps as number | undefined,
					narration: a.narration ? guard.read(String(a.narration)) : undefined,
					bed: a.bed ? guard.read(String(a.bed)) : undefined,
				});
				const sh = join(dir, "film.sh");
				// Confine every file the recipe will write before writing anything.
				for (const w of [...p.writes, sh]) guard.write(w);
				mkdirSync(dir, { recursive: true });
				writeFileSync(sh, p.script);
				return `Preset ${p.preset}: ${slides.length} slides, ${p.total.toFixed(2)} s, cuts at ${p.hits.join(", ") || "none"} s.\nWrote ${sh}. Run: bash ${sh}  -> ${p.output}\nFor a music bed call film_craft action=bed seconds=${p.total.toFixed(2)} hits=[${p.hits.join(",")}] first and pass its wav as bed.\n\n${p.script}`;
			}
			default:
				return "Error: action must be list, plan, bed or mix";
		}
	} catch (e) {
		return `Error: ${e instanceof Error ? e.message : String(e)}`;
	}
}
