/**
 * 8gent AI - Provider Configuration
 *
 * Uses @ai-sdk/openai-compatible to create providers for
 * Ollama, LM Studio, and OpenRouter.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { modelFetchAsFetch } from "./model-fetch";
import { resolveOllamaBaseUrl } from "./text-tool-endpoint";
import { resolveLlamaServerUrl } from "../local-model-server/select";

export type ProviderName = "ollama" | "lmstudio" | "openrouter" | "apfel" | "llama-server";

export interface ProviderConfig {
	name: ProviderName;
	model: string;
	baseURL?: string;
	apiKey?: string;
	headers?: Record<string, string>;
}

const DEFAULT_URLS: Record<Exclude<ProviderName, "ollama" | "llama-server">, string> = {
	lmstudio: "http://localhost:1234/v1",
	openrouter: "https://openrouter.ai/api/v1",
	// apfel (https://github.com/Arthur-Ficial/apfel) exposes Apple Foundation
	// as an OpenAI-compatible HTTP server. Default port 11500 avoids the
	// Ollama collision on 11434. Override via APFEL_BASE_URL.
	apfel: process.env.APFEL_BASE_URL || "http://localhost:11500/v1",
};

/**
 * The OpenAI-compatible base a provider uses when the config names none. For
 * ollama it is resolved at call time from OLLAMA_BASE_URL, then OLLAMA_HOST,
 * then localhost (#3080): a hardcoded localhost here sent the TUI's per-turn
 * task-router classify to this machine even with ollama configured remote.
 *
 * llama-server resolves the same way, from LLAMA_SERVER_URL then
 * 127.0.0.1:8080, through the same helper the provider registry uses so the
 * registry and this factory cannot disagree.
 */
export function defaultBaseUrl(name: ProviderName): string {
	if (name === "ollama") return `${resolveOllamaBaseUrl()}/v1`;
	if (name === "llama-server") return `${resolveLlamaServerUrl()}/v1`;
	return DEFAULT_URLS[name];
}

/**
 * Create a language model from provider config.
 * This is the single entry point for getting an AI SDK model.
 *
 * For OpenRouter free models: uses intelligent retry with exponential
 * backoff (2s, 4s, 8s, 16s, 32s) and up to 8 attempts. Free models
 * allow 1000 calls/day but have per-minute rate limits.
 */
export function createModel(config: ProviderConfig): LanguageModel {
	if (!config.model || typeof config.model !== "string") {
		throw new Error(
			`createModel called without a model id for provider "${config.name}". ` +
				`Pass { name, model } — got model=${JSON.stringify(config.model)}.`,
		);
	}
	const baseURL = config.baseURL || defaultBaseUrl(config.name);
	const isFreeModel = config.model.includes(":free") || config.name === "openrouter";
	const apiKey = config.apiKey || getApiKeyFromEnv(config.name);

	const provider = createOpenAICompatible({
		name: config.name,
		baseURL,
		apiKey,
		// Every generation request goes through modelFetch: Bun's hidden 300 s
		// fetch cap is off and EIGHT_TURN_TIMEOUT_MS bounds the step instead.
		// A hosted provider with no key gets no request at all (#3746): the
		// refusal fires at send time, so a failover loop records it as this
		// provider's error and nothing leaves the machine.
		fetch: hostedWithoutKey(config.name, baseURL, apiKey)
			? refuseWithoutKey(config.name, baseURL)
			: modelFetchAsFetch,
		headers: {
			...config.headers,
			...(config.name === "openrouter"
				? {
						"HTTP-Referer": "https://8gent.app",
						"X-Title": "8gent Code",
					}
				: {}),
		},
		// LM Studio requires `type: "object"` in tool parameter schemas.
		// The AI SDK strips it — patch it back for lmstudio.
		...(config.name === "lmstudio"
			? {
					transformRequestBody: (body: Record<string, unknown>) => {
						if (Array.isArray(body.tools)) {
							body.tools = (body.tools as Array<Record<string, unknown>>).map((t) => {
								const fn = t.function as Record<string, unknown> | undefined;
								if (fn?.parameters && typeof fn.parameters === "object") {
									const params = fn.parameters as Record<string, unknown>;
									if (!params.type) params.type = "object";
								}
								return t;
							});
						}
						return body;
					},
				}
			: {}),
	});

	return provider(config.model);
}

/** Providers that run on the user's machine or LAN and take no key. */
const KEYLESS_PROVIDERS = new Set<string>(["ollama", "lmstudio", "apfel", "llama-server"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * True when a request would go to a hosted endpoint with no API key (#3746).
 * Keyless local providers and loopback endpoints never count as hosted.
 */
export function hostedWithoutKey(name: string, baseURL: string | undefined, apiKey: string | undefined): boolean {
	if (apiKey) return false;
	if (KEYLESS_PROVIDERS.has(name)) return false;
	let host: string;
	try {
		host = new URL(baseURL ?? "").hostname;
	} catch {
		return false; // no usable endpoint: nothing could be sent anyway
	}
	return !LOOPBACK_HOSTS.has(host);
}

/** The key's env var name, for the refusal message. */
function keyEnvName(name: string): string {
	return `${name.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_API_KEY`;
}

/** A fetch that never sends: it rejects with a plain message naming the missing key (#3746). */
function refuseWithoutKey(name: string, baseURL: string): typeof fetch {
	const host = new URL(baseURL).hostname;
	return (async () => {
		throw new Error(
			`No API key for ${name}, so nothing was sent to ${host}. Set ${keyEnvName(name)} to use it, or pick a local provider.`,
		);
	}) as unknown as typeof fetch;
}

/**
 * Get retry config for free models.
 * Free models allow 1000 calls/day but have per-minute rate limits.
 * Use exponential backoff: 2s, 4s, 8s, 16s, 32s across 8 attempts.
 */
export function getRetryConfig(config: ProviderConfig): { maxRetries: number } {
	const isFreeModel = typeof config.model === "string" && config.model.includes(":free");
	return { maxRetries: isFreeModel ? 8 : 3 };
}

function getApiKeyFromEnv(name: ProviderName): string | undefined {
	switch (name) {
		case "openrouter":
			return process.env.OPENROUTER_API_KEY;
		case "lmstudio":
			return process.env.LM_STUDIO_API_KEY || "lm-studio";
		case "ollama":
			return undefined; // Local, no key needed
		case "apfel":
			// apfel optionally accepts a bearer token via APFEL_TOKEN. Default = none.
			return process.env.APFEL_TOKEN || "apfel";
		case "llama-server":
			// llama-server is local and unauthenticated: the provider registry
			// declares apiKeyEnv: "" for it, so send no key.
			return undefined;
	}
}

/**
 * Check if a provider is available by hitting its models endpoint.
 */
export async function isProviderAvailable(config: ProviderConfig): Promise<boolean> {
	const baseURL = config.baseURL || defaultBaseUrl(config.name);
	try {
		const response = await fetch(`${baseURL.replace("/v1", "")}/api/tags`, {
			signal: AbortSignal.timeout(3000),
		}).catch(() =>
			fetch(`${baseURL}/models`, {
				headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
				signal: AbortSignal.timeout(3000),
			}),
		);
		return response.ok;
	} catch {
		return false;
	}
}
