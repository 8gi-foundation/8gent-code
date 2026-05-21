/**
 * local-model-detect.ts - dynamic discovery of locally-available models.
 *
 * The role system must not hardcode model names. Ollama, LM Studio, and the
 * Apple Foundation bridge can each host different models over time. This
 * module probes all three at runtime, scores what it finds, and recommends a
 * strength-matched {role -> provider + model} assignment.
 *
 * Probe targets:
 *   - Ollama          GET  http://localhost:11434/api/tags
 *   - LM Studio       GET  http://localhost:1234/v1/models
 *   - Apple Foundation     ~/.8gent/bin/apple-foundation-bridge (binary present)
 *
 * Consumed by `scripts/sync-local-roles.ts`, which writes the result to
 * `~/.8gent/roles.json` via `saveRoleConfig()`.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RoleConfig, RoleModelAssignment } from "./role-config";

export type LocalProvider = "ollama" | "lmstudio" | "apple-foundation";

export interface DetectedModel {
	provider: LocalProvider;
	model: string;
	/** Heuristic capability score; higher = stronger. */
	score: number;
}

const OLLAMA_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const LMSTUDIO_URL = process.env.LMSTUDIO_BASE_URL || "http://localhost:1234/v1";
const PROBE_TIMEOUT_MS = 3000;

/**
 * Parse a parameter-count hint (in billions) from a model id.
 * "qwen3.6:27b" -> 27, "google/gemma-4-26b-a4b" -> 26, "phi-3-mini" -> 0.
 * Embedding models are deliberately scored 0 so they never win a role.
 */
export function paramHint(modelId: string): number {
	const id = modelId.toLowerCase();
	if (id.includes("embed")) return 0;
	const match = id.match(/(\d+(?:\.\d+)?)\s*b(?![a-z])/);
	return match ? Number.parseFloat(match[1]) : 0;
}

/**
 * Score a detected model. Parameter count dominates; a small constant favours
 * Apple Foundation as an always-available on-device floor even though its
 * parameter count is not advertised.
 */
function scoreModel(provider: LocalProvider, modelId: string): number {
	if (provider === "apple-foundation") return 3; // ~3B on-device, instant.
	return paramHint(modelId);
}

async function fetchJson(url: string): Promise<unknown | null> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

/** Probe Ollama. Returns [] if the server is down. */
export async function detectOllama(): Promise<DetectedModel[]> {
	const json = (await fetchJson(`${OLLAMA_URL}/api/tags`)) as
		| { models?: { name?: string }[] }
		| null;
	if (!json?.models) return [];
	return json.models
		.map((m) => m.name)
		.filter((n): n is string => typeof n === "string")
		.map((model) => ({ provider: "ollama" as const, model, score: scoreModel("ollama", model) }))
		.filter((m) => m.score > 0);
}

/** Probe LM Studio (OpenAI-compatible). Returns [] if the server is down. */
export async function detectLMStudio(): Promise<DetectedModel[]> {
	const json = (await fetchJson(`${LMSTUDIO_URL}/models`)) as { data?: { id?: string }[] } | null;
	if (!json?.data) return [];
	return json.data
		.map((m) => m.id)
		.filter((id): id is string => typeof id === "string")
		.map((model) => ({
			provider: "lmstudio" as const,
			model,
			score: scoreModel("lmstudio", model),
		}))
		.filter((m) => m.score > 0);
}

/** Detect the Apple Foundation bridge. The on-device model is fixed. */
export function detectAppleFoundation(): DetectedModel[] {
	const bridge = join(homedir(), ".8gent", "bin", "apple-foundation-bridge");
	if (!existsSync(bridge)) return [];
	return [{ provider: "apple-foundation", model: "apple-foundationmodel", score: 3 }];
}

/** Probe all three local hosts concurrently. */
export async function detectLocalModels(): Promise<DetectedModel[]> {
	const [ollama, lmstudio] = await Promise.all([detectOllama(), detectLMStudio()]);
	return [...ollama, ...lmstudio, ...detectAppleFoundation()];
}

/**
 * Recommend a strength-matched role assignment from detected models.
 *
 * Strategy - three models become one system, each to its strength:
 *   - orchestrator: the strongest model. Planning is the hardest reasoning.
 *   - engineer:     the strongest *non-orchestrator* model, for code throughput.
 *   - qa:           the strongest model again. Verification must catch real
 *                   bugs, so it never drops to a weaker model.
 *   - fallback:     Apple Foundation when present (instant, on-device,
 *                   always-available), else the weakest detected model.
 *
 * Returns `null` when no local models are detected, so callers can leave the
 * existing roles.json (or platform defaults) untouched rather than writing a
 * broken config.
 */
export function recommendRoleConfig(models: DetectedModel[]): RoleConfig | null {
	if (models.length === 0) return null;

	const ranked = [...models].sort((a, b) => b.score - a.score);
	const toAssignment = (m: DetectedModel): RoleModelAssignment => ({
		provider: m.provider,
		model: m.model,
	});

	const strongest = ranked[0];
	const secondStrongest = ranked[1] ?? ranked[0];
	const apple = ranked.find((m) => m.provider === "apple-foundation");
	const weakest = ranked[ranked.length - 1];

	return {
		schemaVersion: 1,
		orchestrator: toAssignment(strongest),
		engineer: toAssignment(secondStrongest),
		qa: toAssignment(strongest),
		fallback: toAssignment(apple ?? weakest),
	};
}

/** Convenience: detect then recommend in one call. */
export async function recommendFromHost(): Promise<RoleConfig | null> {
	return recommendRoleConfig(await detectLocalModels());
}
