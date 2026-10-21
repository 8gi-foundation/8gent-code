/**
 * 8gent AI - Provider Configuration
 *
 * Uses @ai-sdk/openai-compatible to create providers for
 * Ollama, LM Studio, and OpenRouter.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { resolveLlamaServerUrl } from "../local-model-server/select";
import { trustedEnvValue } from "../permissions/run-command-sandbox";
import {
	missingKeyMessage,
	resolveProviderBaseUrl,
	resolveProviderKey,
} from "../providers/key-resolver";
import { resolveRetrySettings } from "../settings/retry";
import { loadSettings } from "../settings/store";
import { modelFetchAsFetch } from "./model-fetch";
import { resolveOllamaBaseUrl } from "./text-tool-endpoint";

export type LocalOrBuiltinProviderName =
	| "ollama"
	| "lmstudio"
	| "openrouter"
	| "apfel"
	| "llama-server";
/** Any provider in the registry (built-in or declared); the registry supplies its endpoint and key (#4622). */
export type ProviderName = LocalOrBuiltinProviderName | (string & {});

export interface ProviderConfig {
	name: ProviderName;
	model: string;
	baseURL?: string;
	apiKey?: string;
	headers?: Record<string, string>;
}

const DEFAULT_URLS: Record<
	Exclude<LocalOrBuiltinProviderName, "ollama" | "llama-server">,
	string
> = {
	lmstudio: "http://localhost:1234/v1",
	openrouter: "https://openrouter.ai/api/v1",
	// apfel (https://github.com/Arthur-Ficial/apfel) exposes Apple Foundation
	// as an OpenAI-compatible HTTP server. Default port 11500 avoids the
	// Ollama collision on 11434. Override via APFEL_BASE_URL.
	apfel: trustedEnvValue("APFEL_BASE_URL") || "http://localhost:11500/v1",
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
	// A provider outside the four above (minimax, deepseek, a declared one) gets
	// the endpoint its registry entry names, never an undefined base (#4622).
	return (
		(DEFAULT_URLS as Record<string, string | undefined>)[name] ?? resolveProviderBaseUrl(name) ?? ""
	);
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
			: guardedKeyedFetch(modelFetchAsFetch, apiKey),
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

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** Strip `Bearer <token>` and the resolved key itself from a message (#4622). */
export function scrubKey(text: string, apiKey?: string): string {
	let out = text.replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, "Bearer [REDACTED]");
	const k = apiKey?.trim();
	if (k) out = out.split(k).join("[REDACTED]");
	return out;
}

/**
 * Wraps a fetch that carries a provider key:
 *  - a redirect is followed by hand, only to the same origin. A redirect to
 *    another origin is refused, so Authorization is never forwarded there;
 *  - any thrown error has `Bearer <token>` and the key value scrubbed from its
 *    message (and stack) before it can reach a log, a card or a transcript.
 */
export function guardedKeyedFetch(base: typeof fetch, apiKey: string | undefined): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		try {
			let url = input instanceof Request ? input.url : String(input);
			const origin = new URL(url).origin;
			let cur: RequestInit = { ...(init ?? {}), redirect: "manual" };
			for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
				const res = await base(hop === 0 ? input : url, cur);
				const loc = res.headers.get("location");
				if (!REDIRECT_CODES.has(res.status) || !loc) return res;
				const next = new URL(loc, url);
				if (next.origin !== origin) {
					throw new Error(
						`${new URL(url).host} redirected to ${next.host}; not followed, so the key is not sent there.`,
					);
				}
				url = next.toString();
				if (
					res.status === 303 ||
					((res.status === 301 || res.status === 302) && cur.method === "POST")
				) {
					const { body: _b, ...rest } = cur;
					cur = { ...rest, method: "GET", redirect: "manual" };
				}
			}
			throw new Error("Too many redirects.");
		} catch (err) {
			if (err instanceof Error) {
				err.message = scrubKey(err.message, apiKey);
				if (err.stack) err.stack = scrubKey(err.stack, apiKey);
			}
			throw err;
		}
	}) as unknown as typeof fetch;
}

/** Providers that run on the user's machine or LAN and take no key. */
const KEYLESS_PROVIDERS = new Set<string>(["ollama", "lmstudio", "apfel", "llama-server"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * True when a request would go to a hosted endpoint with no API key (#3746).
 * Keyless local providers and loopback endpoints never count as hosted.
 */
export function hostedWithoutKey(
	name: string,
	baseURL: string | undefined,
	apiKey: string | undefined,
): boolean {
	if (apiKey?.trim()) return false;
	if (KEYLESS_PROVIDERS.has(name)) return false;
	let host: string;
	try {
		host = new URL(baseURL ?? "").hostname;
	} catch {
		return false; // no usable endpoint: nothing could be sent anyway
	}
	return !LOOPBACK_HOSTS.has(host);
}

/** A fetch that never sends: it rejects with a plain message naming the missing key (#3746). */
function refuseWithoutKey(name: string, baseURL: string): typeof fetch {
	const host = new URL(baseURL).hostname;
	return (async () => {
		throw new Error(missingKeyMessage(name, host));
	}) as unknown as typeof fetch;
}

/**
 * Get retry config for free models.
 * Free models allow 1000 calls/day but have per-minute rate limits.
 * Use exponential backoff: 2s, 4s, 8s, 16s, 32s across 8 attempts.
 *
 * `settings.retry.maxRetries` (global file, or a project file through the
 * allowlist) overrides the count; an invalid value falls back to 3, or 8 for
 * free models (C4).
 */
export function getRetryConfig(
	config: ProviderConfig,
	retry: Parameters<typeof resolveRetrySettings>[0] = loadSettings().retry,
): { maxRetries: number } {
	const isFreeModel = typeof config.model === "string" && config.model.includes(":free");
	return { maxRetries: resolveRetrySettings(retry).maxRetries ?? (isFreeModel ? 8 : 3) };
}

function getApiKeyFromEnv(name: ProviderName): string | undefined {
	switch (name) {
		case "openrouter":
			return process.env.OPENROUTER_API_KEY || resolveProviderKey(name);
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
		default:
			// Every other provider: its own registry entry decides (#4622).
			return resolveProviderKey(name);
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
