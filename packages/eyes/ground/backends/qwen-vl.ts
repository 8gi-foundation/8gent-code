/**
 * Qwen-VL style grounder over a local endpoint.
 *
 * Two transports, one prompt and one parser:
 *   - "ollama": POST /api/chat with base64 images (qwen2.5vl:7b today).
 *   - "openai": POST /v1/chat/completions with an image_url data URI
 *     (LM Studio; the slot for UI-TARS-1.5-7B, Holo or GUI-Actor later).
 *
 * Coordinate space is per model: Qwen2.5-VL answers in absolute pixels of the
 * image it saw; Qwen3-VL and several UI-tuned models answer on a 0-1000 grid.
 * `coords` says which, so a new model is a config line, not new code.
 */
import { loopbackFetch } from "../loopback.js";
import type { BBox, GroundBackend, PreparedImage } from "../types.js";

export type CoordSpace = "absolute" | "norm1000";

export interface QwenVlOptions {
	id?: string;
	model: string;
	endpoint: string;
	transport: "ollama" | "openai";
	coords: CoordSpace;
	/** Per-call timeout, ms. */
	timeoutMs?: number;
}

export function groundingPrompt(instruction: string): string {
	const target = instruction.trim().replace(/\s+/g, " ").slice(0, 300);
	return [
		`Locate this element in the screenshot: ${target}`,
		'Output only JSON: [{"bbox_2d": [x1, y1, x2, y2], "label": "<short name>"}].',
		"If it is not visible, output [].",
	].join("\n");
}

/**
 * Pull the first box out of a model answer. Accepts bbox_2d (preferred), a bare
 * 4-number array, or point_2d (expanded to a 10px box). Returns null when the
 * model said "not visible" or wrote nothing usable.
 */
export function parseBox(raw: string): BBox | null {
	const text = raw.replace(/```(?:json)?/g, "");
	const nums = (s: string) =>
		s
			.split(/[\s,]+/)
			.filter(Boolean)
			.map(Number);
	const m = /"?bbox_2d"?\s*:\s*\[([^\]]+)\]/.exec(text);
	if (m) {
		const n = nums(m[1]);
		if (n.length >= 4 && n.slice(0, 4).every(Number.isFinite))
			return order([n[0], n[1], n[2], n[3]]);
	}
	const p = /"?point_2d"?\s*:\s*\[([^\]]+)\]/.exec(text);
	if (p) {
		const n = nums(p[1]);
		if (n.length >= 2 && Number.isFinite(n[0]) && Number.isFinite(n[1]))
			return [n[0] - 5, n[1] - 5, n[0] + 5, n[1] + 5];
	}
	const bare =
		/\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/.exec(
			text,
		);
	if (bare) return order([Number(bare[1]), Number(bare[2]), Number(bare[3]), Number(bare[4])]);
	return null;
}

function order(b: BBox): BBox {
	return [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
}

/** Convert a model box into prepared-image pixels. */
export function toImageSpace(b: BBox, coords: CoordSpace, img: PreparedImage): BBox {
	if (coords === "absolute") return b;
	return [
		(b[0] / 1000) * img.width,
		(b[1] / 1000) * img.height,
		(b[2] / 1000) * img.width,
		(b[3] / 1000) * img.height,
	];
}

export class QwenVlBackend implements GroundBackend {
	readonly id: string;
	readonly model: string;
	readonly endpoint: string;
	private readonly opts: QwenVlOptions;

	constructor(opts: QwenVlOptions) {
		this.opts = opts;
		this.id = opts.id ?? `qwen-vl-${opts.transport}`;
		this.model = opts.model;
		this.endpoint = opts.endpoint;
	}

	async locate(img: PreparedImage, instruction: string, signal?: AbortSignal) {
		const prompt = groundingPrompt(instruction);
		const b64 = img.bytes.toString("base64");
		const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 120_000);
		const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
		let raw = "";
		try {
			if (this.opts.transport === "ollama") {
				const res = await loopbackFetch(this.endpoint, "/api/chat", {
					method: "POST",
					headers: { "content-type": "application/json" },
					signal: sig,
					body: JSON.stringify({
						model: this.model,
						stream: false,
						think: false,
						keep_alive: "10m",
						options: { temperature: 0, num_ctx: 4096, num_predict: 128 },
						messages: [{ role: "user", content: prompt, images: [b64] }],
					}),
				});
				if (!res.ok) return { error: `ollama ${res.status}: ${(await res.text()).slice(0, 200)}` };
				const j = (await res.json()) as { message?: { content?: string } };
				raw = j.message?.content ?? "";
			} else {
				const res = await loopbackFetch(this.endpoint, "/v1/chat/completions", {
					method: "POST",
					headers: { "content-type": "application/json" },
					signal: sig,
					body: JSON.stringify({
						model: this.model,
						temperature: 0,
						max_tokens: 128,
						messages: [
							{
								role: "user",
								content: [
									{ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
									{ type: "text", text: prompt },
								],
							},
						],
					}),
				});
				if (!res.ok)
					return { error: `openai-compatible ${res.status}: ${(await res.text()).slice(0, 200)}` };
				const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
				raw = j.choices?.[0]?.message?.content ?? "";
			}
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err), raw };
		}
		const box = parseBox(raw);
		if (!box) return { error: "model returned no box (not visible or unparseable)", raw };
		return { bbox: toImageSpace(box, this.opts.coords, img), raw };
	}
}
