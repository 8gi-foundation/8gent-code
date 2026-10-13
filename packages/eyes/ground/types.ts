/**
 * Grounding contract: a screenshot plus a plain-language target in, one point out.
 *
 * A text planner decides WHAT to act on ("click the Sign in button"); a
 * grounder decides WHERE it is on screen. Keeping the two apart lets any
 * planner (the 27B, a 9B, a cloud model in someone else's build) use the same
 * local grounder, and lets the grounder model be swapped without touching the
 * planner or the tools.
 *
 * Coordinates are always in the pixel space of the image that was passed in.
 * Mapping image pixels to screen points (retina scale, display offset) is the
 * caller's job; packages/computer/coord-map.ts already does it for desktop
 * screenshots.
 */

/** [x1, y1, x2, y2] in image pixels, top-left origin, x1 < x2, y1 < y2. */
export type BBox = [number, number, number, number];

export interface GroundResult {
	/** Click point (centre of bbox), image pixels. */
	x: number;
	y: number;
	bbox: BBox;
	/**
	 * 0..1. Heuristic, not a model probability: the local backends do not
	 * expose token log-probs, so this scores the answer's shape (parsed
	 * cleanly, inside the image, plausible size). Treat < 0.5 as "not found".
	 */
	confidence: number;
	/** Backend id and model that produced the answer. */
	backend: string;
	model: string;
	/** Wall time for the model call, ms. */
	ms: number;
}

export interface GroundFailure {
	ok: false;
	reason: string;
	backend: string;
	model: string;
	ms: number;
	/** Raw model text, for debugging a parse failure. Never logged by default. */
	raw?: string;
}

export type GroundOutcome = ({ ok: true } & GroundResult) | GroundFailure;

export interface GroundInput {
	/** PNG or JPEG bytes, or a path to one. */
	image: Buffer | string;
	/** What to find, e.g. "the Sign in button". */
	instruction: string;
}

/** Image already decoded and sized for the backend. */
export interface PreparedImage {
	/** Encoded bytes sent to the model. */
	bytes: Buffer;
	/** Size the model sees. Model coordinates are in this space. */
	width: number;
	height: number;
	/** Size of the original image. Results are scaled back to this. */
	origWidth: number;
	origHeight: number;
}

export interface GroundBackend {
	/** Stable id, e.g. "qwen-vl-ollama". */
	readonly id: string;
	readonly model: string;
	/** Loopback base URL the backend calls. Checked by assertLoopback before every call. */
	readonly endpoint: string;
	/**
	 * Return a bbox in the PREPARED image's pixel space, or a failure reason.
	 * The caller scales it back to the original image.
	 */
	locate(
		img: PreparedImage,
		instruction: string,
		signal?: AbortSignal,
	): Promise<{ bbox: BBox; raw: string } | { error: string; raw?: string }>;
}
