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
import { dirname, join } from "node:path";
import type { ProviderConfig, ProviderName } from "../providers";
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

/**
 * Unload an Ollama model from memory (keep_alive: 0). On a single machine
 * the local models must time-share RAM rather than co-reside - a resident
 * 27B model can starve a second large model and cause inference failures.
 */
export async function unloadOllamaModel(
	model: string,
	baseUrl = OLLAMA_URL,
): Promise<void> {
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

// ============================================================================
// Provider capability resolver (SPEC-05, issue #108)
//
// A single source of truth for what the ACTIVE provider can actually do, so
// stages depend on capabilities, not on a hardcoded provider-name string or a
// model id. Every field is derived from the stable `ProviderConfig` flags plus
// a best-effort runtime probe that DOWNGRADES fidelity when the served model
// disagrees with its advertised flags (e.g. a local GGUF that 400s on a native
// `tools` payload). The resolver never upgrades beyond what the flags promise.
// ============================================================================

/**
 * How the active provider can be driven to call tools.
 *   native - the model accepts an OpenAI/Anthropic-style `tools` payload.
 *   text   - the harness must inject tool specs into the prompt and parse tool
 *            calls from text (see `packages/ai/text-tools.ts`).
 *   none   - no tool pathway at all (prompt/preview conversational turns only).
 */
export type ToolMode = "native" | "text" | "none";

export interface ProviderCapabilities {
	provider: ProviderName;
	model: string;
	/** Tool-calling pathway available for this provider+model. */
	tools: ToolMode;
	/** Provider can return a reliable structured/JSON verdict (json mode or tool-use). */
	json: boolean;
	/** Usable context window in tokens (conservative floor when unknown). */
	contextWindow: number;
	/** Provider accepts image inputs. */
	vision: boolean;
	/** Provenance of each derived field, for the capability-probe report. */
	source: {
		tools: "flag" | "probe" | "override";
		context: "endpoint" | "known" | "floor";
	};
}

/**
 * Local providers whose served chat templates commonly reject a native `tools`
 * payload. The harness drives them via the text-tool protocol instead. This is
 * the capability answer to "treat Ollama-served 8gent GGUFs as text-tools".
 */
const TEXT_TOOL_PROVIDERS: ReadonlySet<ProviderName> = new Set<ProviderName>([
	"8gent",
	"ollama",
	"lmstudio",
]);

/**
 * Providers with no tool pathway of any kind (apfel + the Apple Foundation
 * bridge). Kept explicit so the resolver never invents tool support the runtime
 * cannot honor. Matches the SPEC-05 "not doing" list (apfel/apple-foundation
 * beyond prompt/preview).
 */
const NO_TOOL_PROVIDERS: ReadonlySet<ProviderName> = new Set<ProviderName>([
	"apfel",
	"apple-foundation",
	"host-cli-primary",
	"host-cli-secondary",
]);

/**
 * Providers known to expose a structured-output path (JSON mode or reliable
 * tool-use) suitable for the validate stage's machine-readable verdict.
 */
const JSON_MODE_PROVIDERS: ReadonlySet<ProviderName> = new Set<ProviderName>([
	"openrouter",
	"openai",
	"anthropic",
	"groq",
	"grok",
	"mistral",
	"together",
	"fireworks",
	"deepseek",
]);

/** Conservative floor when the provider advertises no context window. */
export const CONTEXT_WINDOW_FLOOR = 8192;

/**
 * Fallback context windows when the models endpoint does not advertise one.
 * These are deliberately conservative - real values come from the endpoint.
 */
const KNOWN_CONTEXT: Partial<Record<ProviderName, number>> = {
	"8gent": 32768,
	ollama: 32768,
	lmstudio: 32768,
	anthropic: 200000,
	openai: 128000,
	openrouter: 32768,
	groq: 32768,
	grok: 131072,
	mistral: 32768,
	together: 32768,
	fireworks: 32768,
	deepseek: 65536,
	apfel: CONTEXT_WINDOW_FLOOR,
	"apple-foundation": CONTEXT_WINDOW_FLOOR,
};

/**
 * One-shot native-tools probe. Returns true when the provider accepts a `tools`
 * payload (HTTP 200), false when it rejects it (HTTP 400 / any error). Injected
 * so tests never touch the network.
 */
export interface NativeToolsProbe {
	(args: { baseUrl: string; model: string; apiKey?: string }): Promise<boolean>;
}

/**
 * Context-window lookup against a provider's models endpoint. Returns the
 * advertised window in tokens, or null when unknown. Injected for tests.
 */
export interface ContextWindowLookup {
	(args: { baseUrl: string; model: string; apiKey?: string }): Promise<number | null>;
}

export interface ResolveCapabilitiesOptions {
	probe?: NativeToolsProbe;
	contextLookup?: ContextWindowLookup;
	/** Defaults to `process.env`; injectable so tests control the override. */
	env?: Record<string, string | undefined>;
}

/**
 * Read the `EIGHT_TEXT_TOOLS` override.
 *   "1" -> force text-tools (never native)
 *   "0" -> force native tools
 *   unset/other -> no opinion
 */
function textToolsOverride(env: Record<string, string | undefined>): "1" | "0" | null {
	const raw = env.EIGHT_TEXT_TOOLS;
	if (raw === "1") return "1";
	if (raw === "0") return "0";
	return null;
}

/**
 * Synchronous tool-mode decision from `ProviderConfig` flags + the
 * `EIGHT_TEXT_TOOLS` override. No network. This is the hot-path gate the agent
 * loop consults every turn; the async `resolveCapabilities()` probe only ever
 * downgrades this result.
 */
export function capabilityToolMode(
	cfg: Pick<ProviderConfig, "name" | "supportsTools">,
	env: Record<string, string | undefined> = process.env,
): ToolMode {
	// Providers with no tool pathway can never be forced into one.
	if (NO_TOOL_PROVIDERS.has(cfg.name) || cfg.supportsTools === false) return "none";

	const override = textToolsOverride(env);
	if (override === "1") return "text";
	if (override === "0") return "native";

	// Local GGUF hosts default to the text-tool protocol; their advertised
	// native support is unreliable across chat templates.
	if (TEXT_TOOL_PROVIDERS.has(cfg.name)) return "text";
	return "native";
}

/**
 * Synchronous check: does this provider expose a structured-output path (JSON
 * mode or reliable tool-use) usable for a machine-readable validate verdict?
 * No network. Callers use this to decide whether to trust a structured verdict
 * or degrade to the string heuristic (and log the degrade).
 */
export function providerSupportsJsonMode(cfg: Pick<ProviderConfig, "name">): boolean {
	return JSON_MODE_PROVIDERS.has(cfg.name);
}

/**
 * Synchronous context-window estimate from provider identity, with no network.
 * Returns the known window for the provider or the conservative floor. Callers
 * that need the endpoint-advertised value use `resolveCapabilities()` instead;
 * this feeds hot-path defaults (e.g. compaction) that cannot await a probe.
 */
export function knownContextWindow(cfg: Pick<ProviderConfig, "name">): number {
	return KNOWN_CONTEXT[cfg.name] ?? CONTEXT_WINDOW_FLOOR;
}

/** Default native-tools probe: POST a tiny `tools` request, 200 => native. */
export const defaultNativeToolsProbe: NativeToolsProbe = async ({ baseUrl, model, apiKey }) => {
	if (!baseUrl) return false;
	try {
		const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 1,
				tools: [
					{
						type: "function",
						function: {
							name: "noop",
							description: "probe",
							parameters: { type: "object", properties: {} },
						},
					},
				],
			}),
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		// A 400 is the "this served template rejects tools" signal -> downgrade.
		return res.ok;
	} catch {
		return false;
	}
};

/** Default context lookup: read `context_length` from the models endpoint. */
export const defaultContextWindowLookup: ContextWindowLookup = async ({ baseUrl, model, apiKey }) => {
	if (!baseUrl) return null;
	const json = (await (async () => {
		try {
			const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
				headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			});
			if (!res.ok) return null;
			return await res.json();
		} catch {
			return null;
		}
	})()) as { data?: { id?: string; context_length?: number }[] } | null;
	const entry = json?.data?.find((m) => m.id === model) ?? json?.data?.[0];
	const len = entry?.context_length;
	return typeof len === "number" && len > 0 ? len : null;
};

/**
 * Resolve the full capability profile for a provider. Flags are the floor; the
 * probe only downgrades. Fully deterministic when `probe`/`contextLookup` are
 * injected (tests pass mocks; production passes the network defaults).
 */
export async function resolveCapabilities(
	cfg: ProviderConfig,
	opts: ResolveCapabilitiesOptions = {},
): Promise<ProviderCapabilities> {
	const env = opts.env ?? process.env;
	const override = textToolsOverride(env);

	let tools = capabilityToolMode(cfg, env);
	let toolsSource: ProviderCapabilities["source"]["tools"] = override ? "override" : "flag";

	// One-shot native-tools probe: only runs when we currently believe the
	// provider is native AND the user has not pinned a mode. A 400 downgrades to
	// text-tools. Never upgrades.
	if (tools === "native" && override === null && opts.probe) {
		const nativeOk = await opts.probe({
			baseUrl: cfg.baseUrl,
			model: cfg.defaultModel,
			apiKey: cfg.apiKey,
		});
		if (!nativeOk) {
			tools = "text";
			toolsSource = "probe";
		}
	}

	let contextWindow = KNOWN_CONTEXT[cfg.name] ?? CONTEXT_WINDOW_FLOOR;
	let contextSource: ProviderCapabilities["source"]["context"] = KNOWN_CONTEXT[cfg.name]
		? "known"
		: "floor";
	if (opts.contextLookup) {
		const advertised = await opts.contextLookup({
			baseUrl: cfg.baseUrl,
			model: cfg.defaultModel,
			apiKey: cfg.apiKey,
		});
		if (advertised && advertised > 0) {
			contextWindow = advertised;
			contextSource = "endpoint";
		}
	}

	// JSON/structured verdict is available when the provider is a known JSON-mode
	// host and it still has a working tool/structured path.
	const json = tools !== "none" && JSON_MODE_PROVIDERS.has(cfg.name);

	return {
		provider: cfg.name,
		model: cfg.defaultModel,
		tools,
		json,
		contextWindow,
		vision: cfg.supportsVision === true,
		source: { tools: toolsSource, context: contextSource },
	};
}

// ── Capability cache (alongside roles.json) ─────────────────────────────────

/** Directory holding the roles + capability cache. Mirrors role-config. */
function capabilityConfigDir(): string {
	const override = process.env.EIGHT_ROLE_CONFIG_DIR;
	if (override && override.length > 0) return override;
	return join(homedir(), ".8gent");
}

/** Path of the cached capability report, sibling to `roles.json`. */
export function capabilitiesPath(): string {
	return join(capabilityConfigDir(), "capabilities.json");
}

/** Persist a resolved capability report next to the roles state. Best-effort. */
export function saveCapabilities(caps: ProviderCapabilities): void {
	try {
		const p = capabilitiesPath();
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, JSON.stringify(caps, null, 2));
	} catch {
		// Non-fatal: the cache is an optimization, not a source of truth.
	}
}

/** Load the cached capability report, or null when absent/corrupt. */
export function loadCapabilities(): ProviderCapabilities | null {
	try {
		const p = capabilitiesPath();
		if (!existsSync(p)) return null;
		return JSON.parse(readFileSync(p, "utf-8")) as ProviderCapabilities;
	} catch {
		return null;
	}
}
