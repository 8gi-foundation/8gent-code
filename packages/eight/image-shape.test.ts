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
import * as path from "node:path";
import sharp from "sharp";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { clippedSides, imagesWrittenLine, imagesWrittenSince } from "../ai/image-shape";
import { agentTools, getToolContext, setToolContext } from "../ai/tools";
import { ToolExecutor } from "./tools";

afterAll(cleanupTempDirs);

const W = 1280;
const H = 720;
const BG = 30; // the pilot's #0f2027, near enough in grey
const INK = 230;

type Box = { x: number; y: number; w: number; h: number };

/** A plain slide with light boxes standing in for lines of text. */
function slidePixels(
	boxes: Box[],
	background: (x: number, y: number) => number = () => BG,
): Buffer {
	const px = Buffer.alloc(W * H);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px[y * W + x] = background(x, y);
	for (const b of boxes)
		for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) px[y * W + x] = INK;
	return px;
}

async function writePng(file: string, px: Buffer): Promise<void> {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	await sharp(px, { raw: { width: W, height: H, channels: 1 } })
		.png()
		.toFile(file);
}

// The pilot's slide 2-5: no title, one body line running past both edges.
const PILOT_BODY = [{ x: 0, y: 460, w: W, h: 34 }];
// What it should have drawn: a title and a wrapped body inside the canvas.
const FITTED = [
	{ x: 400, y: 120, w: 480, h: 70 },
	{ x: 140, y: 380, w: 1000, h: 34 },
	{ x: 140, y: 430, w: 900, h: 34 },
];

function past(file: string): void {
	const old = new Date(Date.now() - 60_000);
	fs.utimesSync(file, old, old);
}

describe("clippedSides", () => {
	test("a line wider than the canvas runs off left and right", () => {
		expect(clippedSides(slidePixels(PILOT_BODY), W, H)).toEqual(["left", "right"]);
	});

	test("a title and wrapped body inside the canvas are not flagged", () => {
		expect(clippedSides(slidePixels(FITTED), W, H)).toEqual([]);
	});

	test("too many lines run off the bottom", () => {
		expect(clippedSides(slidePixels([{ x: 140, y: 600, w: 1000, h: 120 }]), W, H)).toEqual([
			"bottom",
		]);
	});

	test("a gradient or photo (corners disagree) is never flagged", () => {
		const gradient = (x: number) => Math.round((x / W) * 200);
		expect(clippedSides(slidePixels(PILOT_BODY, gradient), W, H)).toEqual([]);
	});
});

describe("imagesWrittenLine", () => {
	test("the pilot's five slides: listed, and the four cut-off ones named", async () => {
		const dir = tempDir("image-shape-");
		await writePng(
			path.join(dir, "video/slide_1.png"),
			slidePixels([{ x: 400, y: 120, w: 480, h: 70 }]),
		);
		for (const n of [2, 3, 4, 5])
			await writePng(path.join(dir, `video/slide_${n}.png`), slidePixels(PILOT_BODY));
		const line = await imagesWrittenLine(dir, Date.now() - 5_000);
		expect(line).toBe(
			"Images written: 5 (1280x720): video/slide_1.png, video/slide_2.png, video/slide_3.png, video/slide_4.png, video/slide_5.png. " +
				"video/slide_2.png, video/slide_3.png, video/slide_4.png, video/slide_5.png: drawn content runs off the left and right edges, " +
				"so text there is probably cut off. Wrap or shrink it to fit, re-render, and check each image shows its own content.",
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

	test("only images written since the command started, outside node_modules and dot dirs", async () => {
		const dir = tempDir("image-shape-");
		const old = path.join(dir, "assets/logo.png");
		await writePng(old, slidePixels(PILOT_BODY));
		past(old);
		await writePng(path.join(dir, "node_modules/pkg/icon.png"), slidePixels(FITTED));
		await writePng(path.join(dir, ".cache/thumb.png"), slidePixels(FITTED));
		const start = Date.now() - 2_000;
		expect(imagesWrittenSince(dir, start)).toEqual([]);
		expect(await imagesWrittenLine(dir, start)).toBe("");
	});

	test("an unreadable image is still listed, and the check never throws", async () => {
		const dir = tempDir("image-shape-");
		fs.writeFileSync(path.join(dir, "broken.png"), "not a png");
		expect(await imagesWrittenLine(dir, Date.now() - 5_000)).toBe("Images written: 1: broken.png.");
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

	const CUT = "slide_2.png: drawn content runs off the left and right edges";

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
