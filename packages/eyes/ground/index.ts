/**
 * ground(screenshot, instruction) -> {x, y, bbox, confidence}
 *
 * Local only. The backend is picked by name from a small table so swapping
 * qwen2.5vl:7b for UI-TARS-1.5-7B, Holo or GUI-Actor is one env var:
 *
 *   EIGHT_GROUND_BACKEND   qwen2.5vl (default) | lmstudio | <preset id>
 *   EIGHT_GROUND_MODEL     override the preset's model name
 *   EIGHT_GROUND_ENDPOINT  override the preset's endpoint (must be loopback)
 *   EIGHT_GROUND_COORDS    absolute | norm1000 (override the preset)
 *
 * Every call re-checks the endpoint is loopback before a byte is sent.
 */
import { type CoordSpace, QwenVlBackend } from "./backends/qwen-vl.js";
import { prepareImage, scaleBack } from "./image.js";
import { assertLoopback } from "./loopback.js";
import type { BBox, GroundBackend, GroundInput, GroundOutcome } from "./types.js";

export type {
	BBox,
	GroundBackend,
	GroundInput,
	GroundOutcome,
	GroundResult,
	GroundFailure,
} from "./types.js";
export { assertLoopback, NonLoopbackEndpointError } from "./loopback.js";

interface Preset {
	model: string;
	endpoint: string;
	transport: "ollama" | "openai";
	coords: CoordSpace;
}

const OLLAMA = "http://127.0.0.1:11434";
const LMSTUDIO = "http://127.0.0.1:1234";

/**
 * Known local grounders. Only qwen2.5vl is measured (see eval/README.md);
 * the others are slots with the coordinate space their model cards describe,
 * to be confirmed by running the eval before any of them becomes default.
 */
export const GROUND_PRESETS: Record<string, Preset> = {
	"qwen2.5vl": { model: "qwen2.5vl:7b", endpoint: OLLAMA, transport: "ollama", coords: "absolute" },
	lmstudio: {
		model: "ui-tars-1.5-7b",
		endpoint: LMSTUDIO,
		transport: "openai",
		coords: "absolute",
	},
	"qwen3-vl": { model: "qwen3-vl:8b", endpoint: OLLAMA, transport: "ollama", coords: "norm1000" },
	"qwen3.5": { model: "qwen3.5:9b", endpoint: OLLAMA, transport: "ollama", coords: "norm1000" },
	"muse-glimmer": {
		model: "muse-glimmer:30b-mlx",
		endpoint: OLLAMA,
		transport: "ollama",
		coords: "norm1000",
	},
	gemma4: {
		model: "gemma-4-26b-a4b-it",
		endpoint: LMSTUDIO,
		transport: "openai",
		coords: "norm1000",
	},
};

export const DEFAULT_GROUND_BACKEND = "qwen2.5vl";

export function backendFromEnv(
	env: Record<string, string | undefined> = process.env,
): GroundBackend {
	const name = env.EIGHT_GROUND_BACKEND || DEFAULT_GROUND_BACKEND;
	const preset = GROUND_PRESETS[name];
	if (!preset) {
		throw new Error(
			`ground: unknown backend "${name}". Known: ${Object.keys(GROUND_PRESETS).join(", ")}`,
		);
	}
	const endpoint = env.EIGHT_GROUND_ENDPOINT || preset.endpoint;
	assertLoopback(endpoint);
	const coords = (env.EIGHT_GROUND_COORDS as CoordSpace | undefined) || preset.coords;
	return new QwenVlBackend({
		id: name,
		model: env.EIGHT_GROUND_MODEL || preset.model,
		endpoint,
		transport: preset.transport,
		coords,
	});
}

/**
 * Shape-based confidence. 1.0 means: parsed cleanly, box inside the image,
 * area between 0.002% and 25% of the frame (a control, not the whole page).
 * Each failed check costs a fixed amount. Not a probability.
 */
export function shapeConfidence(
	b: BBox,
	w: number,
	h: number,
	modelBox: BBox,
	modelW: number,
	modelH: number,
): number {
	let c = 1;
	const inside =
		modelBox[0] >= -2 &&
		modelBox[1] >= -2 &&
		modelBox[2] <= modelW + 2 &&
		modelBox[3] <= modelH + 2;
	if (!inside) c -= 0.3;
	const area = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
	const frac = area / (w * h);
	if (area === 0) c -= 0.5;
	else if (frac > 0.25) c -= 0.4;
	else if (frac < 0.00002) c -= 0.2;
	return Math.max(0, Math.round(c * 100) / 100);
}

export async function ground(
	input: GroundInput,
	opts: { backend?: GroundBackend; signal?: AbortSignal } = {},
): Promise<GroundOutcome> {
	const backend = opts.backend ?? backendFromEnv();
	const t0 = performance.now();
	const fail = (reason: string, raw?: string): GroundOutcome => ({
		ok: false,
		reason,
		backend: backend.id,
		model: backend.model,
		ms: Math.round(performance.now() - t0),
		raw,
	});
	const instruction = input.instruction?.trim();
	if (!instruction) return fail("empty instruction");
	try {
		assertLoopback(backend.endpoint);
	} catch (err) {
		return fail((err as Error).message);
	}
	let img: Awaited<ReturnType<typeof prepareImage>>;
	try {
		img = await prepareImage(input.image);
	} catch (err) {
		return fail(`could not read image: ${(err as Error).message}`);
	}
	const out = await backend.locate(img, instruction, opts.signal);
	if ("error" in out) return fail(out.error, out.raw);
	const bbox = scaleBack(out.bbox, img);
	const ms = Math.round(performance.now() - t0);
	return {
		ok: true,
		x: Math.round((bbox[0] + bbox[2]) / 2),
		y: Math.round((bbox[1] + bbox[3]) / 2),
		bbox,
		confidence: shapeConfidence(
			bbox,
			img.origWidth,
			img.origHeight,
			out.bbox,
			img.width,
			img.height,
		),
		backend: backend.id,
		model: backend.model,
		ms,
	};
}
