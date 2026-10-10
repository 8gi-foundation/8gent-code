/**
 * #3770: a model that read a 1280 px mock-up shown downscaled to 1024 eyeballed a
 * 1080 px column with 24 px padding; the mock-up's column is 800 px wide at
 * x=240. read_image now reports measured full-size geometry so the page can be
 * built with the real numbers. Images are raw pixels, no fonts, so the test is
 * the same on every machine.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import sharp from "sharp";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { ToolExecutor } from "./tools";
import { layoutMeasureLine, measureLayout } from "./layout-measure";

afterAll(cleanupTempDirs);

const W = 1280;
const H = 900;

type Box = { x: number; y: number; w: number; h: number };

async function mockup(boxes: Box[]): Promise<string> {
	const px = Buffer.alloc(W * H * 3, 255);
	for (const b of boxes)
		for (let y = b.y; y < b.y + b.h; y++)
			for (let x = b.x; x < b.x + b.w; x++) px.set([0, 0, 0], (y * W + x) * 3);
	const file = path.join(tempDir("layout-measure-"), "mock.png");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	await sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toFile(file);
	return file;
}

describe("measureLayout (#3770)", () => {
	test("reports the content column and its bands in full-size pixels", async () => {
		const file = await mockup([
			{ x: 240, y: 40, w: 180, h: 30 }, // heading
			{ x: 240, y: 100, w: 680, h: 20 }, // paragraph, left of an image
			{ x: 940, y: 100, w: 100, h: 100 }, // image on the right
			{ x: 240, y: 440, w: 800, h: 50 }, // search bar
		]);
		const m = await measureLayout(file);
		expect(m).not.toBeNull();
		expect(m!.width).toBe(W);
		expect(m!.column).toEqual({ left: 240, right: 1040, width: 800 });
		expect(m!.centered).toBe(true);
		const search = m!.bands.find((b) => b.y === 440);
		expect(search).toMatchObject({ x: 240, w: 800, h: 50 });
		const top = m!.bands.find((b) => b.y === 40);
		expect(top).toMatchObject({ x: 240, w: 180, h: 30 });
		// Side by side blocks share a band; the line gives both x-extents.
		const row = m!.bands.find((b) => b.y === 100);
		expect(row?.spans.length).toBe(2);
	});

	test("the line tells the model to use these pixels, not the downscaled view", async () => {
		const file = await mockup([{ x: 240, y: 40, w: 800, h: 30 }]);
		const line = await layoutMeasureLine(file);
		expect(line).toContain("1280");
		expect(line).toContain("240");
		expect(line).toContain("800");
		expect(line.toLowerCase()).toContain("centered");
		expect(line).not.toMatch(/\u2014/);
	});

	test("a flat or unreadable image gives no line, never an error", async () => {
		const flat = await mockup([]);
		expect(await measureLayout(flat)).toBeNull();
		expect(await layoutMeasureLine(path.join(path.dirname(flat), "missing.png"))).toBe("");
	});

	test("read_image on a model that cannot see still carries the measured layout", async () => {
		const file = await mockup([{ x: 240, y: 40, w: 800, h: 30 }]);
		const out = await new ToolExecutor(path.dirname(file)).execute("read_image", {
			path: path.basename(file),
		});
		expect(out).toContain("Measured layout of the full-size image");
		expect(out).toContain("width 800px");
	});

	test("a paragraph beside an image reports its own line tops (#3823)", async () => {
		const file = await mockup([
			{ x: 240, y: 100, w: 680, h: 12 },
			{ x: 240, y: 125, w: 680, h: 12 },
			{ x: 240, y: 150, w: 600, h: 12 },
			{ x: 940, y: 100, w: 100, h: 100 },
		]);
		const m = await measureLayout(file);
		const band = m!.bands.find((b) => b.y === 100)!;
		expect(band.spans[0].rows).toEqual([
			{ y: 100, h: 12 },
			{ y: 125, h: 12 },
			{ y: 150, h: 12 },
		]);
		expect(band.spans[1].rows).toBeUndefined();
		const line = await layoutMeasureLine(file);
		expect(line).toContain("lines: y=100 h=12, y=125 h=12, y=150 h=12");
	});

	test("an inset table cell is reported as an offset from the column left (#3823)", async () => {
		const file = await mockup([
			{ x: 240, y: 40, w: 800, h: 30 },
			{ x: 259, y: 300, w: 57, h: 15 },
			{ x: 415, y: 300, w: 280, h: 15 },
		]);
		const line = await layoutMeasureLine(file);
		expect(line).toContain("x=259 (+19 from column left) w=57");
		expect(line).toContain("x=415 (+175 from column left) w=280");
		expect(line).toContain("position:absolute");
		expect(line).not.toMatch(/\u2014/);
	});
});

describe("page height guidance (#3823)", () => {
	test("tells the model to keep the full mock-up height and names the trailing blank", async () => {
		const file = await mockup([
			{ x: 240, y: 40, w: 180, h: 30 },
			{ x: 240, y: 100, w: 680, h: 20 },
		]);
		const line = await layoutMeasureLine(file);
		expect(line).toContain("total page height: 900px");
		expect(line).toContain("min-height: 900px");
		expect(line).toContain("the last content ends at y=120");
		expect(line).toContain("780px below it is blank canvas");
	});

	test("omits the blank-canvas note when the content fills the image", async () => {
		const file = await mockup([{ x: 240, y: 0, w: 800, h: 900 }]);
		const line = await layoutMeasureLine(file);
		expect(line).toContain("total page height: 900px");
		expect(line).not.toContain("blank canvas");
	});
});
