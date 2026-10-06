/**
 * #3580: in pilot run 2026-10-06_201120/media-brief-video the model drew five
 * 1280x720 slide PNGs inside one `bash video/build.sh`. Every title came out
 * blank and every body was a single line wider than the canvas, cut off at
 * both edges, so four slides looked nearly the same. The command printed
 * "BUILD_OK" and the model finished without ever seeing a pixel. run_command
 * now reports the images a command wrote and any whose content runs off an
 * edge, on both tool paths.
 *
 * Images are built from raw pixels (no fonts, no ImageMagick) so the test is
 * the same on every machine.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import sharp from "sharp";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import {
	clippedSides,
	imagesWrittenLine,
	imagesWrittenSince,
	withImagesWritten,
} from "../ai/image-shape";
import { agentTools, getToolContext, setToolContext } from "../ai/tools";
import { ToolExecutor } from "./tools";

afterAll(cleanupTempDirs);

const W = 1280;
const H = 720;
const BG = 30; // the pilot's #0f2027, near enough in grey
const INK = 230;

type Box = { x: number; y: number; w: number; h: number };

/** A plain slide with light boxes standing in for glyphs and bars. */
function slidePixels(
	boxes: Box[],
	background: (x: number, y: number) => number = () => BG,
	ink = INK,
): Buffer {
	const px = Buffer.alloc(W * H);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px[y * W + x] = background(x, y);
	for (const b of boxes)
		for (let y = b.y; y < Math.min(b.y + b.h, H); y++)
			for (let x = b.x; x < Math.min(b.x + b.w, W); x++) px[y * W + x] = ink;
	return px;
}

/** A line of text as glyph-sized boxes with gaps, the way real text meets an edge. */
function textLine(x: number, y: number, w: number, h: number): Box[] {
	const glyphs: Box[] = [];
	for (let gx = x; gx < x + w; gx += 34) glyphs.push({ x: gx, y, w: 24, h });
	return glyphs;
}

async function writeRaw(
	file: string,
	px: Buffer,
	width = W,
	height = H,
	channels: 1 | 4 = 1,
): Promise<void> {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	await sharp(px, { raw: { width, height, channels } }).png().toFile(file);
}
const writePng = (file: string, px: Buffer) => writeRaw(file, px);

/** RGBA artwork on a transparent canvas: `inside(x, y)` is an opaque blue pixel. */
function iconPixels(size: number, inside: (x: number, y: number) => boolean): Buffer {
	const px = Buffer.alloc(size * size * 4);
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++)
			if (inside(x, y)) px.set([40, 110, 220, 255], (y * size + x) * 4);
	return px;
}

// The pilot's slide 2-5: no title, one body line running past both edges.
const PILOT_BODY = textLine(0, 460, W, 34);
// What it should have drawn: a title and a wrapped body inside the canvas.
const FITTED = [
	...textLine(400, 120, 480, 70),
	...textLine(140, 380, 1000, 34),
	...textLine(140, 430, 900, 34),
];

function past(file: string): void {
	const old = new Date(Date.now() - 60_000);
	fs.utimesSync(file, old, old);
}

const ADVICE =
	"; if that is text, it is cut off. Wrap or shrink it to fit, re-render, and check each image shows its own content.";

describe("clippedSides", () => {
	test("a line wider than the canvas runs off left and right", () => {
		expect(clippedSides(slidePixels(PILOT_BODY), W, H)).toEqual(["left", "right"]);
	});

	test("a title and wrapped body inside the canvas are not flagged", () => {
		expect(clippedSides(slidePixels(FITTED), W, H)).toEqual([]);
	});

	test("too many lines run off the bottom", () => {
		const lines = [600, 650, 700].flatMap((y) => textLine(140, y, 1000, 34));
		expect(clippedSides(slidePixels(lines), W, H)).toEqual(["bottom"]);
	});

	test("a gradient or photo (corners disagree) is never flagged", () => {
		const gradient = (x: number) => Math.round((x / W) * 200);
		expect(clippedSides(slidePixels(PILOT_BODY, gradient), W, H)).toEqual([]);
	});

	test("a full-width divider or accent stripe is a line, not cut-off text", () => {
		expect(clippedSides(slidePixels([{ x: 0, y: 100, w: W, h: 2 }, ...FITTED]), W, H)).toEqual([]);
		expect(clippedSides(slidePixels([{ x: 0, y: 40, w: W, h: 12 }, ...FITTED]), W, H)).toEqual([]);
	});
});

describe("imagesWrittenLine", () => {
	test("the pilot's five slides: listed, and the four cut-off ones named with their edges", async () => {
		const dir = tempDir("image-shape-");
		await writePng(path.join(dir, "video/slide_1.png"), slidePixels(textLine(400, 120, 480, 70)));
		for (const n of [2, 3, 4, 5])
			await writePng(path.join(dir, `video/slide_${n}.png`), slidePixels(PILOT_BODY));
		const line = await imagesWrittenLine(dir, Date.now() - 5_000);
		expect(line).toBe(
			"Images written: 5 (1280x720): video/slide_1.png, video/slide_2.png, video/slide_3.png, video/slide_4.png, video/slide_5.png. " +
				"Content reaches the edge of a plain background in video/slide_2.png (left, right), video/slide_3.png (left, right), " +
				`video/slide_4.png (left, right), video/slide_5.png (left, right)${ADVICE}`,
		);
	});

	test("edges are reported per file, not merged", async () => {
		const dir = tempDir("image-shape-");
		await writePng(path.join(dir, "a.png"), slidePixels(PILOT_BODY));
		await writePng(
			path.join(dir, "b.png"),
			slidePixels([600, 650, 700].flatMap((y) => textLine(140, y, 1000, 34))),
		);
		expect(await imagesWrittenLine(dir, Date.now() - 5_000)).toContain(
			"in a.png (left, right), b.png (bottom); if that is text",
		);
	});

	test("slides that fit get the count only", async () => {
		const dir = tempDir("image-shape-");
		for (const n of [1, 2])
			await writePng(path.join(dir, `video/slide_${n}.png`), slidePixels(FITTED));
		expect(await imagesWrittenLine(dir, Date.now() - 5_000)).toBe(
			"Images written: 2 (1280x720): video/slide_1.png, video/slide_2.png.",
		);
	});

	test("icons, a favicon, a UI screenshot and a striped slide are not flagged", async () => {
		const dir = tempDir("image-shape-");
		// Rounded square touching every edge mid-side, transparent corners.
		await writeRaw(
			path.join(dir, "icon.png"),
			iconPixels(
				512,
				(x, y) =>
					Math.min(x, 511 - x) + Math.min(y, 511 - y) > 60 ||
					(x > 80 && x < 432) ||
					(y > 80 && y < 432),
			),
			512,
			512,
			4,
		);
		await writeRaw(
			path.join(dir, "favicon.png"),
			iconPixels(32, (x, y) => (x - 15.5) ** 2 + (y - 15.5) ** 2 <= 16 ** 2),
			32,
			32,
			4,
		);
		await writePng(
			path.join(dir, "screenshot.png"),
			slidePixels([{ x: 0, y: 100, w: W, h: 2 }, ...textLine(40, 40, 400, 30)], () => 255, 20),
		);
		await writePng(
			path.join(dir, "striped.png"),
			slidePixels([{ x: 0, y: 40, w: W, h: 12 }, ...FITTED]),
		);
		const line = await imagesWrittenLine(dir, Date.now() - 5_000);
		expect(line).toStartWith(
			"Images written: 4: favicon.png, icon.png, screenshot.png, striped.png.",
		);
		expect(line).not.toContain("Content reaches");
	});

	test("build/ output is checked; old images, node_modules and dot dirs are not", async () => {
		const dir = tempDir("image-shape-");
		const old = path.join(dir, "assets/logo.png");
		await writePng(old, slidePixels(PILOT_BODY));
		past(old);
		await writePng(path.join(dir, "node_modules/pkg/icon.png"), slidePixels(FITTED));
		await writePng(path.join(dir, ".cache/thumb.png"), slidePixels(FITTED));
		await writePng(path.join(dir, "build/slides/s1.png"), slidePixels(FITTED));
		const start = Date.now() - 2_000;
		expect(imagesWrittenSince(dir, start).map((f) => path.relative(dir, f.file))).toEqual([
			"build/slides/s1.png",
		]);
	});

	test("an unreadable image is still listed, and the check never throws", async () => {
		const dir = tempDir("image-shape-");
		fs.writeFileSync(path.join(dir, "broken.png"), "not a png");
		expect(await imagesWrittenLine(dir, Date.now() - 5_000)).toBe("Images written: 1: broken.png.");
	});

	test("a home directory or filesystem root is never listed", async () => {
		expect(await imagesWrittenLine(homedir(), 0)).toBe("");
		expect(await imagesWrittenLine("/", 0)).toBe("");
	});
});

describe("withImagesWritten", () => {
	test("a refused command gets no line, even with fresh images around", async () => {
		const dir = tempDir("image-shape-");
		await writePng(path.join(dir, "fresh.png"), slidePixels(PILOT_BODY));
		for (const refused of [
			"[PERMISSION DENIED] User declined to execute: cp a b",
			"[BLOCKED] Semicolon command chaining is not allowed.",
			"[SYSTEM ONE BLOCKED] no",
		])
			expect(await withImagesWritten(refused, dir, Date.now() - 5_000)).toBe(refused);
		expect(await withImagesWritten("ok", dir, Date.now() - 5_000)).toStartWith(
			"ok\nImages written: 1",
		);
	});
});

describe("run_command reports the images it wrote, on both tool paths", () => {
	const saved = process.env.EIGHT_SYSTEM_ONE;
	let dir: string;
	beforeEach(async () => {
		// System One judges commands with a model; this test is about the result line.
		process.env.EIGHT_SYSTEM_ONE = "0";
		dir = tempDir("image-shape-run-");
		const src = path.join(dir, "src.png");
		await writePng(src, slidePixels(PILOT_BODY));
		past(src);
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.EIGHT_SYSTEM_ONE;
		else process.env.EIGHT_SYSTEM_ONE = saved;
	});

	const CUT = "Content reaches the edge of a plain background in slide_2.png (left, right)";

	test("ToolExecutor (text-tool and local providers)", async () => {
		const out = await new ToolExecutor(dir).execute("run_command", {
			command: "cp src.png slide_2.png",
		});
		expect(out).toContain("\nImages written: 1 (1280x720): slide_2.png.");
		expect(out).toContain(CUT);
	});

	test("AI SDK registry", async () => {
		const before = getToolContext();
		setToolContext({ ...before, workingDirectory: dir });
		try {
			const out = await agentTools.run_command.execute?.(
				{ command: "cp src.png slide_2.png" },
				{ toolCallId: "t", messages: [] },
			);
			expect(out).toContain("\nImages written: 1 (1280x720): slide_2.png.");
			expect(out).toContain(CUT);
		} finally {
			setToolContext(before);
		}
	});

	test("a command that writes no image is unchanged", async () => {
		const out = await new ToolExecutor(dir).execute("run_command", { command: "echo hi" });
		expect(out).not.toContain("Images written");
	});
});
