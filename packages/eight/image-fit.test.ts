/** #4293: the resize decision and the note that lets a model map a copy back to original pixels. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { rmRetry } from "../../tests/rm-retry";
import {
	HOSTED_IMAGE_MAX_SIDE,
	LOCAL_IMAGE_MAX_SIDE,
	downscaleNote,
	imageMaxSide,
} from "./image-fit";
import { layoutMeasureLine } from "./layout-measure";
import { loadRunImage } from "./run";

describe("imageMaxSide", () => {
	test("local and hosted both get 2560", () => {
		expect(LOCAL_IMAGE_MAX_SIDE).toBe(2560);
		expect(imageMaxSide(true, undefined)).toBe(LOCAL_IMAGE_MAX_SIDE);
		expect(imageMaxSide(false, undefined)).toBe(HOSTED_IMAGE_MAX_SIDE);
	});
	test("a sane env override wins, a junk one is ignored", () => {
		expect(imageMaxSide(true, "4096")).toBe(4096);
		expect(imageMaxSide(false, "12")).toBe(HOSTED_IMAGE_MAX_SIDE);
		expect(imageMaxSide(false, "abc")).toBe(HOSTED_IMAGE_MAX_SIDE);
	});
});

describe("downscaleNote", () => {
	test("states original size, copy size and the factor", () => {
		const note = downscaleNote({ width: 2560, height: 1440 }, { width: 1024, height: 576 });
		expect(note).toContain("2560x1440");
		expect(note).toContain("1024x576");
		expect(note).toContain("by 2.5");
	});
	test("says nothing when the copy is the original", () => {
		expect(downscaleNote({ width: 800, height: 600 }, { width: 800, height: 600 })).toBe("");
	});
});

describe("layoutMeasureLine and loadRunImage", () => {
	let dir: string;
	let big: Buffer;
	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "imgfit-"));
		big = await sharp({
			create: { width: 2560, height: 1440, channels: 3, background: "#ffffff" },
		})
			.composite([
				{
					input: await sharp({
						create: { width: 800, height: 200, channels: 3, background: "#000000" },
					})
						.png()
						.toBuffer(),
					left: 400,
					top: 300,
				},
			])
			.png()
			.toBuffer();
		writeFileSync(join(dir, "shot.png"), big);
	});
	afterAll(() => rmRetry(dir));

	test("a downscaled copy is never called full-size; it names the original and the factor", async () => {
		const copy = await sharp(big).resize(1024, 576).png().toBuffer();
		const line = await layoutMeasureLine(copy, { width: 2560, height: 1440 });
		expect(line).toContain("downscaled copy (1024x576 px)");
		expect(line).toContain("original image (2560x1440 px)");
		expect(line).toContain("multiply by 2.5");
		expect(line).not.toContain("full-size image (1024x576");
	});
	test("only a downscaled copy gets the downscale wording", async () => {
		const copy = await sharp(big).resize(1024, 576).png().toBuffer();
		const down = await layoutMeasureLine(copy, { width: 2560, height: 1440 });
		const same = await layoutMeasureLine(big, { width: 2560, height: 1440 });
		const none = await layoutMeasureLine(big);
		expect(down).toContain("downscaled");
		expect(same).not.toContain("downscaled");
		expect(none).not.toContain("downscaled");
		expect(same.split("\n")[0]).toBe("Measured layout of the full-size image (2560x1440 px):");
	});
	test("the original keeps the full-size wording", async () => {
		const line = await layoutMeasureLine(big, { width: 2560, height: 1440 });
		expect(line).toContain("full-size image (2560x1440 px");
	});
	test("loadRunImage sends the original to a hosted provider", async () => {
		const r = await loadRunImage("shot.png", dir, "openrouter");
		if ("error" in r) throw new Error(r.error);
		const meta = await sharp(Buffer.from(r.base64, "base64")).metadata();
		expect([meta.width, meta.height]).toEqual([2560, 1440]);
		expect(r.original).toEqual({ width: 2560, height: 1440 });
	});
	test("loadRunImage sends the original to a local provider too", async () => {
		const r = await loadRunImage("shot.png", dir, "ollama");
		if ("error" in r) throw new Error(r.error);
		const meta = await sharp(Buffer.from(r.base64, "base64")).metadata();
		expect([meta.width, meta.height]).toEqual([2560, 1440]);
		expect(r.original).toEqual({ width: 2560, height: 1440 });
	});
	test("EIGHT_IMAGE_MAX_SIDE=1024 still downscales a local image and reports the original", async () => {
		const prev = process.env.EIGHT_IMAGE_MAX_SIDE;
		process.env.EIGHT_IMAGE_MAX_SIDE = "1024";
		try {
			const r = await loadRunImage("shot.png", dir, "ollama");
			if ("error" in r) throw new Error(r.error);
			const meta = await sharp(Buffer.from(r.base64, "base64")).metadata();
			expect([meta.width, meta.height]).toEqual([1024, 576]);
			expect(r.original).toEqual({ width: 2560, height: 1440 });
		} finally {
			if (prev === undefined) process.env.EIGHT_IMAGE_MAX_SIDE = undefined;
			else process.env.EIGHT_IMAGE_MAX_SIDE = prev;
		}
	});
});
