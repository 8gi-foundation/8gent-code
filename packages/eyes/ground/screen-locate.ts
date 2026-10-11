/**
 * screen_locate: the planner names a target in words, the grounder returns a
 * point. Pure glue over ground(); the tool in packages/eight/tools.ts only adds
 * the path guard. Output is short JSON a small local model can copy from.
 */
import { prepareImage } from "./image.js";
import { ground } from "./index.js";
import type { GroundBackend } from "./types.js";

export const SCREEN_LOCATE_MIN_CONFIDENCE = 0.5;

/** "1280x800" -> [1280, 800]; anything else -> null. */
export function parseViewport(v: unknown): [number, number] | null {
	const m = typeof v === "string" ? /^\s*(\d{2,5})\s*[x,X]\s*(\d{2,5})\s*$/.exec(v) : null;
	return m ? [Number(m[1]), Number(m[2])] : null;
}

export async function screenLocate(
	args: { image: string; target: string; viewport?: string },
	opts: { backend?: GroundBackend } = {},
): Promise<string> {
	const vp = args.viewport ? parseViewport(args.viewport) : null;
	if (args.viewport && !vp) return `Error: viewport must look like "1280x800", got "${args.viewport}"`;
	const r = await ground({ image: args.image, instruction: args.target }, opts);
	if (!r.ok) return `Not found: ${r.reason}`;
	if (r.confidence < SCREEN_LOCATE_MIN_CONFIDENCE) {
		return `Not found: "${args.target}" (confidence ${r.confidence}). Try a more specific description.`;
	}
	const out: Record<string, unknown> = { x: r.x, y: r.y, bbox: r.bbox, confidence: r.confidence, space: "image" };
	if (vp) {
		const img = await prepareImage(args.image);
		out.cssX = Math.round((r.x * vp[0]) / img.origWidth);
		out.cssY = Math.round((r.y * vp[1]) / img.origHeight);
		out.space = "image; cssX/cssY are viewport CSS pixels";
	}
	return JSON.stringify(out);
}
