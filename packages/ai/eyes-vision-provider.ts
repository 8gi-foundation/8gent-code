/**
 * Shared VisionProvider adapter for the eyes capability.
 *
 * Single source of truth used by both:
 *   - the agent tool wiring in packages/ai/tools.ts (eyes_describe)
 *   - the headless CLI in apps/8gent-eyes/src/index.ts
 *
 * Two-phase contract per spec §4.2 / §8.4:
 *   1. resolveProviderId(req) -> provider id (no inference call)
 *   2. describe(req) -> actual inference (only after caller's tier check)
 *
 * Uses packages/eight/vision-router to discover the resolved model + provider,
 * then dispatches to provider-specific inference (Ollama HTTP for local,
 * OpenRouter HTTP for remote). Resolution is memoized for the process so
 * repeated calls hit the same provider that was tier-checked.
 *
 * Closes the privacy bug in #2508 by construction: the eyes backend gets
 * the provider id BEFORE calling describe(), so denied requests never trigger
 * the inference HTTP call.
 */

import * as fs from "node:fs";
import type {
	VisionProvider,
	VisionRequest,
	VisionResponse,
} from "@8gent/eyes";
import { findVisionModel, loadVisionConfig } from "../eight/vision-router";
import { describeImage } from "../tools/image";

interface ResolvedModel {
	provider: "ollama" | "openrouter";
	model: string;
	displayName: string;
}

let _cached: ResolvedModel | null = null;

async function resolveOnce(): Promise<ResolvedModel> {
	if (_cached) return _cached;
	const cfg = loadVisionConfig();
	const r = await findVisionModel({ config: cfg });
	if (!r.found || !r.model) {
		throw new Error(
			r.error ??
				"vision: no model available. Install one of: `ollama pull qwen2.5-vl` (local) OR set OPENROUTER_API_KEY (remote, requires perception:remote tier).",
		);
	}
	_cached = {
		provider: r.model.provider,
		model: r.model.model,
		displayName: r.model.displayName,
	};
	return _cached;
}

/**
 * Reset the resolution cache. Useful for tests and after vision config edits.
 */
export function resetVisionResolutionCache(): void {
	_cached = null;
}

async function callOllamaVision(
	model: string,
	frame: VisionRequest["frame"],
	prompt: string,
): Promise<VisionResponse> {
	// Reuse the existing helper which handles resize + base64 + Ollama POST.
	const baseModel = model.split(":")[0] ?? model;
	const r = await describeImage(frame.path, prompt, baseModel);
	return {
		provider: "ollama",
		model: r.model,
		text: r.description,
	};
}

async function callOpenRouterVision(
	model: string,
	frame: VisionRequest["frame"],
	prompt: string,
): Promise<VisionResponse> {
	const apiKey = process.env.OPENROUTER_API_KEY;
	const buf = await fs.promises.readFile(frame.path);
	const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;

	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers,
		body: JSON.stringify({
			model,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: prompt },
						{ type: "image_url", image_url: { url: dataUrl } },
					],
				},
			],
		}),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "(no body)");
		throw new Error(`openrouter vision: HTTP ${res.status} ${body.slice(0, 200)}`);
	}
	const json = (await res.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
		usage?: { total_tokens?: number };
	};
	return {
		provider: "openrouter",
		model,
		text: json.choices?.[0]?.message?.content ?? "",
		tokens: json.usage?.total_tokens,
	};
}

export const eyesVisionProvider: VisionProvider = {
	async resolveProviderId(_req: VisionRequest): Promise<string> {
		const m = await resolveOnce();
		return m.provider;
	},

	async describe(req: VisionRequest): Promise<VisionResponse> {
		const m = await resolveOnce();
		if (m.provider === "ollama") return callOllamaVision(m.model, req.frame, req.prompt);
		if (m.provider === "openrouter") return callOpenRouterVision(m.model, req.frame, req.prompt);
		throw new Error(`vision: unsupported provider ${m.provider}`);
	},
};
