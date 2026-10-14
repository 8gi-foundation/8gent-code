/**
 * 8gent Code - how big an image the model is shown, and what it is told about it (#4293).
 *
 * The prompt talks in the original image's pixels. A copy shrunk to fit 1024x1024
 * makes every coordinate the model reads off it wrong by the scale factor, and the
 * measured-layout block used to call that copy "full-size". Two rules fix it:
 * send the original when it is within the cap, and whenever a copy is sent, say so
 * with the original size and the factor that maps copy pixels back.
 *
 * Local runtimes keep 1024 (the bound set in #3641 so a Retina screenshot does not
 * swamp a small context); hosted providers get 2560. EIGHT_IMAGE_MAX_SIDE overrides both.
 */

export const LOCAL_IMAGE_MAX_SIDE = 1024;
export const HOSTED_IMAGE_MAX_SIDE = 2560;

/** The longest side, in px, an image may have when it reaches the model. */
export function imageMaxSide(
	local: boolean,
	env: string | undefined = process.env.EIGHT_IMAGE_MAX_SIDE,
): number {
	const n = Number(env);
	if (Number.isInteger(n) && n >= 256 && n <= 8192) return n;
	return local ? LOCAL_IMAGE_MAX_SIDE : HOSTED_IMAGE_MAX_SIDE;
}

export type ResizePlan = { resize: boolean; width: number; height: number; scale: number };

/** Whether an image of width x height needs a downscale to fit `maxSide`, and to what. */
export function planResize(width: number, height: number, maxSide: number): ResizePlan {
	const long = Math.max(width, height);
	if (!(long > maxSide) || width < 1 || height < 1)
		return { resize: false, width, height, scale: 1 };
	const scale = maxSide / long;
	return {
		resize: true,
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
		scale,
	};
}

type Size = { width: number; height: number };

/** True when the copy shown is smaller than the original. */
export function isDownscaled(orig: Size, shown: Size): boolean {
	return shown.width < orig.width || shown.height < orig.height;
}

/**
 * The sentence that lets the model map coordinates back, or "" when the copy is the
 * original size. The factor is original / copy, so original = copy * factor.
 */
export function downscaleNote(orig: Size, shown: Size): string {
	if (!isDownscaled(orig, shown)) return "";
	const f = Number((orig.width / shown.width).toFixed(3));
	return `The image you see is a downscaled copy (${shown.width}x${shown.height} px) of the original (${orig.width}x${orig.height} px). Multiply every x and y you read off the copy by ${f} to get original pixels; the task and any click target are in original pixels.`;
}
