/**
 * Tests for perceptualDiff (closes #2525).
 *
 * Generates synthetic PNGs in /tmp via pngjs (no fixture files committed)
 * and asserts:
 *   - identical PNGs report similarity = 1, regions = []
 *   - a 100x100 white square injection yields similarity < 1 with one
 *     region containing that square
 *   - 4K (3840x2160) diff completes inside the 200ms perf budget
 *   - threshold parameter actually changes sensitivity
 *   - mismatched dimensions produce a whole-frame fallback
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { perceptualDiff } from "./perceptual-diff.js";

const TMP_ROOT = join(tmpdir(), `8gent-eyes-pdiff-${Date.now()}`);
mkdirSync(TMP_ROOT, { recursive: true });

afterAll(() => {
	try {
		rmSync(TMP_ROOT, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

function makePng(
	w: number,
	h: number,
	fill: { r: number; g: number; b: number },
	overlay?: { x: number; y: number; w: number; h: number; r: number; g: number; b: number },
): Buffer {
	const png = new PNG({ width: w, height: h, colorType: 6 });
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const idx = (y * w + x) * 4;
			png.data[idx] = fill.r;
			png.data[idx + 1] = fill.g;
			png.data[idx + 2] = fill.b;
			png.data[idx + 3] = 255;
		}
	}
	if (overlay) {
		const ox1 = Math.min(w, overlay.x + overlay.w);
		const oy1 = Math.min(h, overlay.y + overlay.h);
		for (let y = overlay.y; y < oy1; y++) {
			for (let x = overlay.x; x < ox1; x++) {
				const idx = (y * w + x) * 4;
				png.data[idx] = overlay.r;
				png.data[idx + 1] = overlay.g;
				png.data[idx + 2] = overlay.b;
				png.data[idx + 3] = 255;
			}
		}
	}
	return PNG.sync.write(png);
}

function writePng(name: string, buf: Buffer): string {
	const path = join(TMP_ROOT, name);
	writeFileSync(path, buf);
	return path;
}

describe("perceptualDiff", () => {
	it("identical PNGs return similarity=1 and regions=[]", async () => {
		const buf = makePng(256, 256, { r: 30, g: 30, b: 30 });
		const a = writePng("identical-a.png", buf);
		const b = writePng("identical-b.png", buf);

		const r = await perceptualDiff(a, b);
		expect(r.similarity).toBe(1);
		expect(r.regions).toEqual([]);
		expect(r.pixelsDifferent).toBe(0);
	});

	it("100x100 white square added yields similarity<1 with one region containing it", async () => {
		const baseFill = { r: 30, g: 30, b: 30 };
		const overlay = { x: 100, y: 100, w: 100, h: 100, r: 255, g: 255, b: 255 };
		const a = writePng("base.png", makePng(512, 512, baseFill));
		const b = writePng("with-square.png", makePng(512, 512, baseFill, overlay));

		const r = await perceptualDiff(a, b);
		expect(r.similarity).toBeLessThan(1);
		expect(r.similarity).toBeGreaterThan(0.9); // single 100x100 patch in a 512x512 frame is small
		expect(r.regions.length).toBeGreaterThanOrEqual(1);
		expect(r.pixelsDifferent).toBeGreaterThan(0);

		// Region should contain the 100x100 patch (allow downscale slack on both sides)
		const slack = 8 * 2; // one downscale cell of slack on each edge
		const containsPatch = r.regions.some(
			(reg) =>
				reg.x <= overlay.x + slack &&
				reg.y <= overlay.y + slack &&
				reg.x + reg.width >= overlay.x + overlay.w - slack &&
				reg.y + reg.height >= overlay.y + overlay.h - slack,
		);
		expect(containsPatch).toBe(true);
	});

	it("4K diff completes inside 200ms perf budget", async () => {
		const W = 3840;
		const H = 2160;
		const baseFill = { r: 50, g: 50, b: 50 };
		const overlay = { x: 1000, y: 800, w: 200, h: 200, r: 240, g: 240, b: 240 };
		const a = writePng("4k-a.png", makePng(W, H, baseFill));
		const b = writePng("4k-b.png", makePng(W, H, baseFill, overlay));

		// Warm pass - first run pays for PNG parsing setup. Measure the second.
		await perceptualDiff(a, b);

		const t0 = performance.now();
		const r = await perceptualDiff(a, b);
		const elapsed = performance.now() - t0;

		expect(r.similarity).toBeLessThan(1);
		expect(r.regions.length).toBeGreaterThanOrEqual(1);
		expect(elapsed).toBeLessThan(200);
	}, 15_000);

	it("threshold parameter changes sensitivity", async () => {
		// Subtle delta: 20/255 per channel. Below default threshold (30), so
		// default returns similarity=1. With threshold=10 the cells flip.
		const a = writePng("subtle-a.png", makePng(256, 256, { r: 100, g: 100, b: 100 }));
		const b = writePng(
			"subtle-b.png",
			makePng(256, 256, { r: 100, g: 100, b: 100 }, { x: 0, y: 0, w: 256, h: 256, r: 120, g: 120, b: 120 }),
		);

		const lowSensitivity = await perceptualDiff(a, b, { threshold: 30 });
		const highSensitivity = await perceptualDiff(a, b, { threshold: 10 });

		expect(lowSensitivity.similarity).toBe(1);
		expect(highSensitivity.similarity).toBeLessThan(1);
		expect(highSensitivity.pixelsDifferent).toBeGreaterThan(lowSensitivity.pixelsDifferent);
	});

	it("mismatched dimensions return whole-frame fallback", async () => {
		const a = writePng("dim-a.png", makePng(256, 256, { r: 0, g: 0, b: 0 }));
		const b = writePng("dim-b.png", makePng(512, 256, { r: 0, g: 0, b: 0 }));

		const r = await perceptualDiff(a, b);
		expect(r.similarity).toBe(0);
		expect(r.regions).toEqual([{ x: 0, y: 0, width: 512, height: 256 }]);
		expect(r.pixelsDifferent).toBe(512 * 256);
	});

	it("region opt restricts the comparison area", async () => {
		// Difference is OUTSIDE the region; should report no change.
		const baseFill = { r: 0, g: 0, b: 0 };
		const overlay = { x: 400, y: 400, w: 50, h: 50, r: 255, g: 255, b: 255 };
		const a = writePng("region-a.png", makePng(512, 512, baseFill));
		const b = writePng("region-b.png", makePng(512, 512, baseFill, overlay));

		const r = await perceptualDiff(a, b, {
			region: { x: 0, y: 0, width: 200, height: 200 },
		});
		expect(r.similarity).toBe(1);
		expect(r.regions).toEqual([]);
	});
});
