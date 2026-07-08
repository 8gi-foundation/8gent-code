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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RoleConfig, RoleModelAssignment } from "./role-config";

export type LocalProvider = "ollama" | "lmstudio" | "apple-foundation";

export interface DetectedModel {
	provider: LocalProvider;
	model: string;
	/** Heuristic capability score; higher = stronger. */
	score: number;
	/**
	 * Whether the model's served chat template accepts a native `tools`
	 * payload. `false` means a trivial tools probe returned 400 ("can't accept
	 * tools" - broken jinja template); such a model must never be picked for
	 * agentic (tool-requiring) work, no matter its parameter count (Law 2,
	 * issue #2747). Undefined = not probed.
	 */
	toolCapable?: boolean;
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

/** Result of a native-tools probe. "unknown" = endpoint unreachable / not probeable. */
export type ToolCapability = "native" | "none" | "unknown";

/** OpenAI-compatible chat-completions endpoint per probeable local provider. */
function chatCompletionsUrl(provider: string): string | null {
	if (provider === "lmstudio") return `${LMSTUDIO_URL}/chat/completions`;
	if (provider === "ollama") return `${OLLAMA_URL}/v1/chat/completions`;
	return null; // apple-foundation has no HTTP endpoint - never probed, never demoted.
}

/**
 * Probe whether a local model can accept a native `tools` payload (Law 2,
 * issue #2747). Sends ONE trivial chat-completions request with a no-op tool
 * and max_tokens: 1.
 *
 *   - 200                      -> "native"  (the template accepts tools)
 *   - 400                      -> "none"    (broken jinja template, e.g. gemma
 *                                            missing format_type_argument -
 *                                            "can't accept tools")
 *   - anything else / no reach -> "unknown" (do not demote on uncertainty)
 *
 * `fetchImpl` is injectable so tests can drive all three branches offline.
 */
export async function probeToolCapability(
	provider: string,
	model: string,
	opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<ToolCapability> {
	const url = chatCompletionsUrl(provider);
	if (!url) return "unknown";
	const doFetch = opts?.fetchImpl ?? fetch;
	try {
		const res = await doFetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: "ping" }],
				tools: [
					{
						type: "function",
						function: {
							name: "noop",
							description: "capability probe",
							parameters: { type: "object", properties: {} },
						},
					},
				],
				max_tokens: 1,
				stream: false,
			}),
			signal: AbortSignal.timeout(opts?.timeoutMs ?? 90_000),
		});
		if (res.ok) return "native";
		if (res.status === 400) return "none";
		return "unknown";
	} catch {
		return "unknown";
	}
}

const TOOL_CAPABILITY_CACHE_PATH = join(homedir(), ".8gent", "tool-capability.json");
const TOOL_CAPABILITY_TTL_MS = Number(process.env.EIGHT_TOOL_PROBE_TTL_MS || 12 * 60 * 60 * 1000);
const toolCapabilityMemo = new Map<string, ToolCapability>();

type CapabilityCacheFile = Record<string, { capability: ToolCapability; checkedAt: number }>;

function readCapabilityCache(): CapabilityCacheFile {
	try {
		return JSON.parse(readFileSync(TOOL_CAPABILITY_CACHE_PATH, "utf-8")) as CapabilityCacheFile;
	} catch {
		return {};
	}
}

function writeCapabilityCache(cache: CapabilityCacheFile): void {
	try {
		mkdirSync(join(homedir(), ".8gent"), { recursive: true });
		writeFileSync(TOOL_CAPABILITY_CACHE_PATH, JSON.stringify(cache, null, 2));
	} catch {
		// Cache is an optimisation; a write failure must never break a turn.
	}
}

/**
 * Cached tool-capability lookup: probes at most once per model per TTL
 * (in-memory memo + `~/.8gent/tool-capability.json`), so agentic turns pay the
 * probe once, not per turn. "unknown" results are NOT cached to disk so a
 * temporarily-down endpoint gets re-probed next time.
 */
export async function getToolCapability(
	provider: string,
	model: string,
	opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<ToolCapability> {
	const key = `${provider}::${model}`;
	const memo = toolCapabilityMemo.get(key);
	if (memo) return memo;

	const cache = readCapabilityCache();
	const hit = cache[key];
	if (hit && Date.now() - hit.checkedAt < TOOL_CAPABILITY_TTL_MS && hit.capability !== "unknown") {
		toolCapabilityMemo.set(key, hit.capability);
		return hit.capability;
	}

	const capability = await probeToolCapability(provider, model, opts);
	toolCapabilityMemo.set(key, capability);
	if (capability !== "unknown") {
		cache[key] = { capability, checkedAt: Date.now() };
		writeCapabilityCache(cache);
	}
	return capability;
}

/**
 * Agentic score: a model that is KNOWN to reject a tools payload scores 0 for
 * tool-requiring work regardless of parameter count. Parameter count only
 * breaks ties among tool-capable (or unprobed) models.
 */
export function scoreForAgentic(m: DetectedModel): number {
	return m.toolCapable === false ? 0 : m.score;
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
	const json = (await fetchJson(`${OLLAMA_URL}/api/tags`)) as {
		models?: { name?: string }[];
	} | null;
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

	// Law 2 (issue #2747): the orchestrator/engineer/qa roles do tool-work, so
	// a model KNOWN to reject a `tools` payload (toolCapable === false) is
	// excluded from the ranking whenever any other candidate exists. Parameter
	// count never outranks the ability to actually execute.
	const capable = models.filter((m) => m.toolCapable !== false);
	const pool = capable.length > 0 ? capable : models;
	const ranked = [...pool].sort((a, b) => scoreForAgentic(b) - scoreForAgentic(a));
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

/**
 * Unload an Ollama model from memory (keep_alive: 0). On a single machine
 * the local models must time-share RAM rather than co-reside - a resident
 * 27B model can starve a second large model and cause inference failures.
 */
export async function unloadOllamaModel(model: string, baseUrl = OLLAMA_URL): Promise<void> {
	try {
		await fetch(`${baseUrl}/api/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model, keep_alive: 0 }),
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
	} catch {
		// Best-effort: an unload failure is not fatal to the caller.
	}
}

/** Convenience: detect then recommend in one call. */
export async function recommendFromHost(): Promise<RoleConfig | null> {
	return recommendRoleConfig(await detectLocalModels());
}
