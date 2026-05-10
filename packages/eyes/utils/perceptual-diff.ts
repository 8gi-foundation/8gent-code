/**
 * @8gent/eyes - perceptual diff utility.
 *
 * Replaces v0 byte-equality (SHA-256 file compare) with a real per-pixel
 * diff that returns:
 *   - similarity in [0, 1]
 *   - changed regions as bounding boxes
 *   - exact pixelsDifferent count
 *
 * Closes #2525. Used by PeekabooEyes.diff() so observe() events carry
 * meaningful sub-frame regions, which the handeyes capability (#2526)
 * relies on for re-annotation triggers.
 *
 * Algorithm:
 *   1. Read both PNGs via pngjs (pure JS, ~200KB; sharp considered and
 *      rejected to avoid the 30MB native binary on every install).
 *   2. Reject mismatched raw dimensions early (similarity = 0,
 *      regions = whole frame).
 *   3. Downscale to 1/DOWNSCALE resolution by block-averaging RGB. This
 *      cuts the work by DOWNSCALE^2 (default 64x) and smooths over
 *      single-pixel noise.
 *   4. Per-pixel R/G/B delta. If any channel exceeds threshold the cell
 *      is "different".
 *   5. Connected-component labelling (4-connected BFS) over the binary
 *      mask, accumulating bounding boxes per component.
 *   6. Tiny fragments below MIN_REGION_PIXELS in downscaled space are
 *      dropped to avoid flooding the output with noise.
 *   7. Bounding boxes scaled back up to RAW pixel coords.
 *
 * Coords are RAW pixels in the returned regions. The peekaboo backend
 * divides by Frame.scale to convert to logical coords for its callers.
 *
 * Performance budget: <200ms on a 3840x2160 RAW frame on M-series.
 */

import { existsSync, readFileSync } from "node:fs";
import { PNG } from "pngjs";

export interface Region {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PerceptualDiffOpts {
	region?: Region;        // restrict comparison to this raw-pixel region
	threshold?: number;     // per-channel delta in 0..255; default 30
	downscale?: number;     // block size for downscaling; default 8
	minRegionPixels?: number; // drop components smaller than this in downscaled space; default 4
}

export interface PerceptualDiffResult {
	similarity: number;     // 0..1, clamped
	regions: Region[];      // raw-pixel bounding boxes of changed components
	pixelsDifferent: number; // count of CHANGED downscaled cells, scaled back to raw-pixel-equivalent area
}

const DEFAULT_THRESHOLD = 30;
const DEFAULT_DOWNSCALE = 8;
const DEFAULT_MIN_REGION_PIXELS = 4;

function readPng(path: string): PNG {
	if (!existsSync(path)) {
		throw new Error(`perceptualDiff: file not found: ${path}`);
	}
	return PNG.sync.read(readFileSync(path));
}

/**
 * Block-average downscale to 1/scale resolution. Returns RGB triplets in
 * a Uint8ClampedArray of length dw*dh*3. Alpha is ignored (PeekabooEyes
 * captures opaque desktop frames).
 */
function downscaleRGB(
	src: Buffer,
	srcW: number,
	srcH: number,
	scale: number,
	region?: Region,
): { data: Uint8ClampedArray; w: number; h: number; ox: number; oy: number } {
	// Clamp region to image bounds (raw pixels).
	const rx = region ? Math.max(0, Math.min(srcW, Math.floor(region.x))) : 0;
	const ry = region ? Math.max(0, Math.min(srcH, Math.floor(region.y))) : 0;
	const rw = region
		? Math.max(0, Math.min(srcW - rx, Math.floor(region.width)))
		: srcW;
	const rh = region
		? Math.max(0, Math.min(srcH - ry, Math.floor(region.height)))
		: srcH;

	const dw = Math.max(1, Math.floor(rw / scale));
	const dh = Math.max(1, Math.floor(rh / scale));
	const out = new Uint8ClampedArray(dw * dh * 3);

	for (let dy = 0; dy < dh; dy++) {
		const sy0 = ry + dy * scale;
		const sy1 = Math.min(ry + rh, sy0 + scale);
		for (let dx = 0; dx < dw; dx++) {
			const sx0 = rx + dx * scale;
			const sx1 = Math.min(rx + rw, sx0 + scale);
			let r = 0;
			let g = 0;
			let b = 0;
			let n = 0;
			for (let sy = sy0; sy < sy1; sy++) {
				const rowOffset = sy * srcW * 4;
				for (let sx = sx0; sx < sx1; sx++) {
					const idx = rowOffset + sx * 4;
					r += src[idx] ?? 0;
					g += src[idx + 1] ?? 0;
					b += src[idx + 2] ?? 0;
					n++;
				}
			}
			if (n > 0) {
				const di = (dy * dw + dx) * 3;
				out[di] = Math.round(r / n);
				out[di + 1] = Math.round(g / n);
				out[di + 2] = Math.round(b / n);
			}
		}
	}
	return { data: out, w: dw, h: dh, ox: rx, oy: ry };
}

/**
 * 4-connected BFS over the binary mask. Returns bounding boxes (in
 * downscaled coords) for each connected component above minPixels.
 */
function findComponents(
	mask: Uint8Array,
	w: number,
	h: number,
	minPixels: number,
): Array<{ x: number; y: number; w: number; h: number; pixels: number }> {
	const visited = new Uint8Array(w * h);
	const components: Array<{ x: number; y: number; w: number; h: number; pixels: number }> = [];
	const queue = new Int32Array(w * h);

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const idx = y * w + x;
			if (mask[idx] === 0 || visited[idx] === 1) continue;

			let head = 0;
			let tail = 0;
			queue[tail++] = idx;
			visited[idx] = 1;

			let minX = x;
			let minY = y;
			let maxX = x;
			let maxY = y;
			let count = 0;

			while (head < tail) {
				const p = queue[head++] ?? 0;
				const px = p % w;
				const py = (p - px) / w;
				count++;
				if (px < minX) minX = px;
				if (px > maxX) maxX = px;
				if (py < minY) minY = py;
				if (py > maxY) maxY = py;

				// 4-neighbours
				if (px > 0) {
					const np = p - 1;
					if (mask[np] === 1 && visited[np] === 0) {
						visited[np] = 1;
						queue[tail++] = np;
					}
				}
				if (px < w - 1) {
					const np = p + 1;
					if (mask[np] === 1 && visited[np] === 0) {
						visited[np] = 1;
						queue[tail++] = np;
					}
				}
				if (py > 0) {
					const np = p - w;
					if (mask[np] === 1 && visited[np] === 0) {
						visited[np] = 1;
						queue[tail++] = np;
					}
				}
				if (py < h - 1) {
					const np = p + w;
					if (mask[np] === 1 && visited[np] === 0) {
						visited[np] = 1;
						queue[tail++] = np;
					}
				}
			}

			if (count >= minPixels) {
				components.push({
					x: minX,
					y: minY,
					w: maxX - minX + 1,
					h: maxY - minY + 1,
					pixels: count,
				});
			}
		}
	}
	return components;
}

/**
 * Compute a perceptual diff between two PNG files at given paths.
 *
 * Returned regions are in RAW pixel coords of the source PNGs. Callers
 * needing logical (DPI-independent) coords must divide by the frame's
 * backing scale factor.
 *
 * Throws on missing files or mismatched RAW dimensions cannot be diffed
 * meaningfully; in that case we return similarity=0 + the whole frame as
 * a single region, which matches the v0 fallback contract.
 */
export async function perceptualDiff(
	pathA: string,
	pathB: string,
	opts: PerceptualDiffOpts = {},
): Promise<PerceptualDiffResult> {
	const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
	const scale = Math.max(1, Math.floor(opts.downscale ?? DEFAULT_DOWNSCALE));
	const minPixels = opts.minRegionPixels ?? DEFAULT_MIN_REGION_PIXELS;

	const pngA = readPng(pathA);
	const pngB = readPng(pathB);

	// Mismatched raw dimensions: cannot align pixel-for-pixel. Honest fallback
	// is "totally different, whole frame is the region".
	if (pngA.width !== pngB.width || pngA.height !== pngB.height) {
		const w = Math.max(pngA.width, pngB.width);
		const h = Math.max(pngA.height, pngB.height);
		return {
			similarity: 0,
			regions: [{ x: 0, y: 0, width: w, height: h }],
			pixelsDifferent: w * h,
		};
	}

	const a = downscaleRGB(pngA.data, pngA.width, pngA.height, scale, opts.region);
	const b = downscaleRGB(pngB.data, pngB.width, pngB.height, scale, opts.region);

	if (a.w !== b.w || a.h !== b.h) {
		// Defensive; downscale of equal-sized inputs should never disagree.
		return {
			similarity: 0,
			regions: [{ x: 0, y: 0, width: pngA.width, height: pngA.height }],
			pixelsDifferent: pngA.width * pngA.height,
		};
	}

	const dw = a.w;
	const dh = a.h;
	const total = dw * dh;
	const mask = new Uint8Array(total);
	let differentCells = 0;

	for (let i = 0; i < total; i++) {
		const di = i * 3;
		const dr = Math.abs((a.data[di] ?? 0) - (b.data[di] ?? 0));
		const dg = Math.abs((a.data[di + 1] ?? 0) - (b.data[di + 1] ?? 0));
		const db = Math.abs((a.data[di + 2] ?? 0) - (b.data[di + 2] ?? 0));
		if (dr > threshold || dg > threshold || db > threshold) {
			mask[i] = 1;
			differentCells++;
		}
	}

	const components = findComponents(mask, dw, dh, minPixels);

	// Scale bounding boxes back to RAW pixel coords. Add the region offset
	// so coords are in source-image space, not region-local space.
	const regions: Region[] = components.map((c) => ({
		x: a.ox + c.x * scale,
		y: a.oy + c.y * scale,
		width: c.w * scale,
		height: c.h * scale,
	}));

	// Convert "different downscaled cells" to a raw-pixel-equivalent count
	// so callers can reason about magnitude consistently with image area.
	const pixelsDifferent = differentCells * scale * scale;

	const similarity = Math.max(0, Math.min(1, 1 - differentCells / total));

	return { similarity, regions, pixelsDifferent };
}
