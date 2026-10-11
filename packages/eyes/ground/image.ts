/**
 * Size a screenshot for a Qwen-VL style grounder.
 *
 * Qwen2.5-VL answers in ABSOLUTE pixels of the image it actually saw. Ollama
 * resizes images internally (smart-resize to multiples of 28, capped at
 * 1280 * 28 * 28 pixels). If we let it, the model's coordinates live in a
 * space we never observe. So we do the resize ourselves to a size that is
 * already a fixed point of that function, and scale answers back exactly.
 */
import sharp from "sharp";
import type { BBox, PreparedImage } from "./types.js";

export const QWEN_FACTOR = 28;
export const QWEN_MAX_PIXELS = 1280 * 28 * 28;
export const QWEN_MIN_PIXELS = 56 * 56;

/** Qwen2.5-VL smart_resize: nearest multiples of `factor`, area within [min, max]. */
export function smartResize(
	width: number,
	height: number,
	factor = QWEN_FACTOR,
	minPixels = QWEN_MIN_PIXELS,
	maxPixels = QWEN_MAX_PIXELS,
): { width: number; height: number } {
	let h = Math.max(factor, Math.round(height / factor) * factor);
	let w = Math.max(factor, Math.round(width / factor) * factor);
	if (h * w > maxPixels) {
		const beta = Math.sqrt((height * width) / maxPixels);
		h = Math.max(factor, Math.floor(height / beta / factor) * factor);
		w = Math.max(factor, Math.floor(width / beta / factor) * factor);
	} else if (h * w < minPixels) {
		const beta = Math.sqrt(minPixels / (height * width));
		h = Math.ceil((height * beta) / factor) * factor;
		w = Math.ceil((width * beta) / factor) * factor;
	}
	return { width: w, height: h };
}

export async function loadImage(image: Buffer | string): Promise<Buffer> {
	if (typeof image !== "string") return image;
	return Buffer.from(await Bun.file(image).arrayBuffer());
}

export async function prepareImage(
	image: Buffer | string,
	opts: { maxPixels?: number } = {},
): Promise<PreparedImage> {
	const src = await loadImage(image);
	const meta = await sharp(src).metadata();
	if (!meta.width || !meta.height) throw new Error("ground: could not read image size");
	const { width, height } = smartResize(
		meta.width,
		meta.height,
		QWEN_FACTOR,
		QWEN_MIN_PIXELS,
		opts.maxPixels ?? QWEN_MAX_PIXELS,
	);
	const bytes = await sharp(src).resize(width, height, { fit: "fill" }).png().toBuffer();
	return { bytes, width, height, origWidth: meta.width, origHeight: meta.height };
}

/** Scale a bbox from prepared-image space back to the original, clamped to the image. */
export function scaleBack(b: BBox, img: PreparedImage): BBox {
	const sx = img.origWidth / img.width;
	const sy = img.origHeight / img.height;
	const cx = (v: number) => Math.min(img.origWidth, Math.max(0, Math.round(v * sx)));
	const cy = (v: number) => Math.min(img.origHeight, Math.max(0, Math.round(v * sy)));
	return [cx(b[0]), cy(b[1]), cx(b[2]), cy(b[3])];
}
