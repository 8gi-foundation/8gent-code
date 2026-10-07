/**
 * film-craft (#3599): the catalog is whole, the plan is a real recipe, the bed is a real wav.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateBed } from "./bed";
import {
	CATALOG,
	filmCraft,
	hueOk,
	listPresets,
	mixPresets,
	planFilm,
	resolvePreset,
} from "./index";

const made: string[] = [];
const tmp = (p: string) => {
	const d = mkdtempSync(join(tmpdir(), p));
	made.push(d);
	return d;
};
afterAll(() => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});
const fonts = (cands: string[]) => cands[cands.length - 1];
const slides = [
	{ title: "The Tide Library", kicker: "Practice brief", seconds: 4 },
	{ title: "Borrow tools", sub: "Drills and ladders", seconds: 3.5 },
	{ title: "One card", seconds: 3 },
	{ title: "Saturday hours", lower: "10:00 to 16:00", seconds: 4 },
	{ title: "Run by volunteers", seconds: 5 },
];

describe("catalog", () => {
	test("every film resolves every component it names", () => {
		const films = Object.keys(CATALOG.films);
		expect(films.length).toBeGreaterThanOrEqual(6);
		for (const f of films) {
			const p = resolvePreset(f);
			for (const k of [
				"palette",
				"typeScale",
				"titleCard",
				"lowerThird",
				"grade",
				"camera",
				"transition",
				"pacing",
				"bed",
			] as const)
				expect(p[k]).toBeDefined();
		}
	});

	test("no colour in the catalog sits in the banned 270-350 hue band", () => {
		for (const pal of Object.values(CATALOG.palettes))
			for (const hex of Object.values(pal)) expect(hueOk(hex)).toBe(true);
		expect(hueOk("#9B59B6")).toBe(false); // purple
		expect(hueOk("#E8A832")).toBe(true); // amber
		expect(hueOk("#808080")).toBe(true); // grey has no hue
	});

	test("list names each film with its description", () => {
		const l = listPresets();
		expect(l.map((x) => x.name)).toContain("lotus-night");
		expect(l.every((x) => x.description.length > 10)).toBe(true);
	});

	test("unknown preset is refused, not substituted", () => {
		expect(() => resolvePreset("nope")).toThrow(/unknown preset/);
	});
});

describe("plan", () => {
	const p = planFilm({
		slides,
		preset: "lotus-night",
		outDir: "/w/video",
		width: 1280,
		height: 720,
		resolveFont: fonts,
	});

	test("picture length is exactly the sum of slide durations; hits are slide starts", () => {
		expect(p.total).toBeCloseTo(19.5, 5);
		expect(p.hits).toEqual([4, 7.5, 10.5, 14.5]);
	});

	test("draws each slide twice with magick (soft then sharp) and never uses drawtext", () => {
		expect(p.script.match(/ magick /g)!.length).toBe(10);
		expect(p.script).not.toContain("drawtext");
	});

	test("ffmpeg applies camera, transitions and the grade at the asked size", () => {
		const ff = p.script;
		expect(ff.match(/xfade=transition=fade/g)!.length).toBe(4 + 5); // 4 cuts + 5 text blur-ins
		expect(ff).toContain("zoompan");
		expect(ff).toContain("colorbalance");
		expect(ff).toContain("vignette");
		expect(ff).toContain("format=gbrp,split"); // bloom must blend in RGB, never on YUV chroma
		expect(ff).toContain("s=1280x720");
	});

	test("bed and narration are mixed with the voice ducking the bed", () => {
		const q = planFilm({
			slides,
			preset: "lotus-night",
			outDir: "/w",
			narration: "/w/voice.wav",
			bed: "/w/bed.wav",
			resolveFont: fonts,
		});
		expect(q.script).toContain("sidechaincompress");
		expect(q.script).toContain("/w/voice.wav");
	});

	test("bad input is refused", () => {
		expect(() =>
			planFilm({ slides: [], preset: "lotus-night", outDir: "/w", resolveFont: fonts }),
		).toThrow();
		expect(() =>
			planFilm({
				slides: [{ title: "x", seconds: 0 }],
				preset: "lotus-night",
				outDir: "/w",
				resolveFont: fonts,
			}),
		).toThrow();
	});
});

describe("film.sh never runs model text", () => {
	test("width, height and fps must be integers in range", () => {
		const base = { slides, preset: "lotus-night", outDir: "/w", resolveFont: fonts };
		expect(() => planFilm({ ...base, width: "1 $(touch x)" as unknown as number })).toThrow(
			/width/,
		);
		expect(() => planFilm({ ...base, height: "tall" as unknown as number })).toThrow(/height/);
		expect(() => planFilm({ ...base, fps: "24" as unknown as number })).toThrow(/fps/);
		expect(() => planFilm({ ...base, width: 8000 })).toThrow(/width/);
		expect(() => planFilm({ ...base, fps: 23.5 })).toThrow(/fps/);
	});

	test("slide text with $(), backticks and quotes runs as text, not commands", async () => {
		const d = tmp("fc-inject-");
		const marker = join(d, "PWNED");
		const evil = `$(touch ${marker}) \`touch ${marker}\` "it's" '$(touch ${marker})' %d @x`;
		const r = await filmCraft({
			action: "plan",
			out_dir: d,
			width: 160,
			height: 90,
			fps: 12,
			slides: [{ title: evil, kicker: evil, sub: evil, lower: evil, seconds: 1 }],
		});
		expect(r).toContain("Wrote");
		const run = Bun.spawnSync(["bash", join(d, "film.sh")], { stdout: "pipe", stderr: "pipe" });
		expect(run.exitCode).toBe(0);
		expect(existsSync(marker)).toBe(false);
		expect(existsSync(join(d, "film.mp4"))).toBe(true);
	}, 120_000);
});

describe("mix", () => {
	test("grade and camera from the first film, titles and palette from the second", () => {
		const m = mixPresets("paper-docs", "lotus-night");
		expect(m.grade).toEqual(CATALOG.grades.print);
		expect(m.camera).toEqual(CATALOG.cameras.locked);
		expect(m.palette).toEqual(CATALOG.palettes["night-amber"]);
		expect(m.typeScale).toEqual(CATALOG.typeScales.editorial);
		expect(m.name).toBe("paper-docs+lotus-night");
	});
});

describe("bed", () => {
	const dir = tmp("fc-");
	test("writes a 48 kHz stereo wav of the asked length, loud enough, peak at -1 dBFS, deterministic", () => {
		const a = generateBed({
			seconds: 3,
			hits: [1.5],
			out: join(dir, "a.wav"),
			bed: "a-minor-lift",
		});
		const b = generateBed({
			seconds: 3,
			hits: [1.5],
			out: join(dir, "b.wav"),
			bed: "a-minor-lift",
		});
		const buf = readFileSync(a.path);
		expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
		expect(buf.readUInt16LE(22)).toBe(2);
		expect(buf.readUInt32LE(24)).toBe(48000);
		expect(buf.readUInt32LE(40)).toBe(3 * 48000 * 4);
		expect(Buffer.compare(buf, readFileSync(b.path))).toBe(0);
		expect(a.peakDb).toBeLessThanOrEqual(-0.9);
		expect(a.rmsDb).toBeGreaterThan(-40);
	});
});

describe("tool", () => {
	test("film_craft list / plan / mix / bed / bad action", async () => {
		const d = tmp("fct-");
		expect(await filmCraft({ action: "list" })).toContain("lotus-night");
		const plan = await filmCraft({
			action: "plan",
			preset: "ice-brief",
			out_dir: d,
			slides: JSON.stringify(slides),
		});
		expect(plan).toContain("ffmpeg ");
		expect(
			await filmCraft({
				action: "plan",
				preset: "ice-brief",
				grade_from: "ember-launch",
				out_dir: d,
				slides,
			}),
		).toContain("ember-launch+ice-brief");
		expect(readFileSync(join(d, "film.sh"), "utf8")).toContain("set -euo pipefail");
		expect(
			await filmCraft({
				action: "bed",
				preset: "ice-brief",
				seconds: 2,
				out: join(d, "sub", "bed.wav"),
				hits: "[1]",
			}),
		).toContain("D minor");
		expect(await filmCraft({ action: "dance" })).toMatch(/^Error/);
	});
});
