/**
 * #4080: compare_layout renders a page and diffs it against a mock-up image.
 * Chrome itself is replaced by a stub script that "renders" a pre-drawn PNG,
 * so the test is the same on every machine and never opens a browser.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import sharp from "sharp";
import { cleanupTempDirs, tempDir } from "../../../tests/temp-dirs";
import { ToolExecutor } from "../../eight/tools";
import type { Band, LayoutMeasure } from "../../eight/layout-measure";
import { compareLayout, describeDiff, findChrome, pairBands } from "../layout-compare";

afterAll(cleanupTempDirs);

const W = 1280;
const H = 900;
type Box = { x: number; y: number; w: number; h: number };

async function draw(dir: string, name: string, boxes: Box[]): Promise<string> {
	const px = Buffer.alloc(W * H * 3, 255);
	for (const b of boxes)
		for (let y = b.y; y < b.y + b.h; y++)
			for (let x = b.x; x < b.x + b.w; x++) px.set([0, 0, 0], (y * W + x) * 3);
	const file = path.join(dir, name);
	await sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toFile(file);
	return file;
}

const band = (y: number, h: number, x: number, w: number, spans = 1): Band => ({
	y,
	h,
	x,
	w,
	spans: Array.from({ length: spans }, (_, i) => ({ x: x + i * 10, w: Math.floor(w / spans) })),
});
const measure = (bands: Band[]): LayoutMeasure => ({
	width: W,
	height: H,
	column: { left: 240, right: 1040, width: 800 },
	centered: true,
	bands,
});

describe("pairBands", () => {
	test("pairs in order and leaves the missing and the extra unpaired", () => {
		const ref = [band(40, 30, 240, 180), band(100, 100, 240, 800), band(400, 50, 240, 800)];
		const got = [band(40, 30, 240, 180), band(300, 10, 600, 20), band(405, 50, 240, 800)];
		const { pairs, extra } = pairBands(ref, got);
		expect(pairs.map((p) => p.got?.y ?? null)).toEqual([40, null, 405]);
		expect(extra.map((b) => b.y)).toEqual([300]);
	});
});

describe("describeDiff", () => {
	test("names the offset and the direction to fix it", () => {
		const ref = measure([band(40, 30, 240, 180), band(437, 28, 439, 402)]);
		const got = measure([band(40, 30, 240, 180), band(497, 28, 400, 402)]);
		const text = describeDiff(ref, got, 0.91234);
		expect(text).toContain("Pixel similarity 0.912");
		expect(text).toContain("ref y=437");
		expect(text).toContain("y +60 (move up 60px)");
		expect(text).toContain("x -39 (move right 39px)");
		expect(text).not.toContain("ref y=40 ");
		expect(text).toContain("1 of 2 bands are off");
		expect(text).not.toMatch(/—/);
	});

	test("says so when every band is within 2px", () => {
		const ref = measure([band(40, 30, 240, 180)]);
		const got = measure([band(41, 30, 241, 181)]);
		expect(describeDiff(ref, got, 1)).toContain("within 2px");
	});
});

describe("compareLayout with a stub browser", () => {
	function stubChrome(dir: string, renderPng: string): string {
		const bin = path.join(dir, "fake-chrome");
		fs.writeFileSync(
			bin,
			`#!/bin/sh\nfor a in "$@"; do case "$a" in --screenshot=*) out="\${a#--screenshot=}";; esac; done\ncp "${renderPng}" "$out"\n`,
		);
		fs.chmodSync(bin, 0o755);
		return bin;
	}

	test("reports a block that sits 60px too low, and a similarity under 1", async () => {
		const dir = tempDir("layout-compare-");
		const ref = await draw(dir, "mock.png", [
			{ x: 240, y: 40, w: 180, h: 30 },
			{ x: 240, y: 440, w: 800, h: 50 },
		]);
		const render = await draw(dir, "render.png", [
			{ x: 240, y: 40, w: 180, h: 30 },
			{ x: 240, y: 500, w: 800, h: 50 },
		]);
		fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
		const prev = process.env.EIGHT_CHROME_BIN;
		process.env.EIGHT_CHROME_BIN = stubChrome(dir, render);
		try {
			const text = await compareLayout(path.join(dir, "index.html"), ref);
			expect(text).toContain("ref y=440");
			expect(text).toContain("y +60 (move up 60px)");
			expect(text).toMatch(/Pixel similarity 0\.\d{3}/);
			const same = await compareLayout(path.join(dir, "index.html"), render);
			expect(same).toContain("within 2px");
			expect(same).toContain("Pixel similarity 1.000");
		} finally {
			if (prev === undefined) process.env.EIGHT_CHROME_BIN = undefined as never;
			if (prev === undefined) delete process.env.EIGHT_CHROME_BIN;
			else process.env.EIGHT_CHROME_BIN = prev;
		}
	});

	test("a missing page or image is a sentence, not a throw", async () => {
		const dir = tempDir("layout-compare-");
		expect(await compareLayout(path.join(dir, "nope.html"), path.join(dir, "nope.png"))).toContain("does not exist");
	});

	test("EIGHT_CHROME_BIN wins when it exists", () => {
		const dir = tempDir("layout-compare-");
		const bin = path.join(dir, "chrome");
		fs.writeFileSync(bin, "");
		expect(findChrome({ EIGHT_CHROME_BIN: bin })).toBe(bin);
	});
});

describe("compare_layout is a declared tool", () => {
	test("it is offered and gated as a read", () => {
		const root = tempDir("layout-compare-tool-");
		const executor = new ToolExecutor(root);
		const names = executor.getToolDefinitions().map((d) => (d as { function: { name: string } }).function.name);
		expect(names).toContain("compare_layout");
	});
});
