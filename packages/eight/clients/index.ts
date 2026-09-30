/**
 * LLM Client Factory & Exports
 */

import {
	type RoleModelAssignment,
	type RoleName,
	loadRoleConfig,
} from "../../orchestration/role-config";
import { type ProviderCompat, type ProviderName, getProviderManager } from "../../providers";
import type { AgentConfig, LLMClient } from "../types";
import { AnthropicClient } from "./anthropic";
import { ApfelClient } from "./apfel";
import { AppleFoundationClient } from "./apple-foundation";
import { DeepSeekClient } from "./deepseek";
import { LMStudioClient } from "./lmstudio";
import { resolveLlamaServerUrl } from "../../local-model-server/select";
import { OllamaClient } from "./ollama";
import { OpenRouterClient } from "./openrouter";

export { OllamaClient } from "./ollama";
export { LMStudioClient } from "./lmstudio";
export { OpenRouterClient } from "./openrouter";
export { AnthropicClient } from "./anthropic";
export { AppleFoundationClient } from "./apple-foundation";
export { ApfelClient } from "./apfel";
export { DeepSeekClient } from "./deepseek";

/**
 * Thrown by `createClientForRole` when a role's configured provider is
 * disabled on the current host (e.g. apple-foundation on Linux). Callers
 * catch this and prompt the user to install or switch providers.
 */
export class RoleProviderUnavailableError extends Error {
	constructor(
		public role: string,
		public provider: string,
	) {
		super(`Provider "${provider}" required for role "${role}" is not available on this host`);
		this.name = "RoleProviderUnavailableError";
	}
}

/**
 * Map a declared provider's wire shape to the client that speaks it. The
 * "openrouter" runtime is the generic OpenAI Chat-Completions client; the name
 * is historical, the shape is what matters here.
 */
export function runtimeForCompat(compat: ProviderCompat): AgentConfig["runtime"] {
	switch (compat) {
		case "ollama":
			return "ollama";
		case "anthropic":
			return "anthropic";
		default:
			return "openrouter";
	}
}

/**
 * Map a `ProviderName` to the `AgentConfig.runtime` literal understood by
 * `createClient()`. Providers that don't map to a runtime fall through to
 * the OpenRouter path since those are all OpenAI-compatible HTTP APIs.
 */
export function runtimeForProvider(provider: ProviderName): AgentConfig["runtime"] {
	switch (provider) {
		case "apple-foundation":
			return "apple-foundation";
		case "apfel":
			return "apfel";
		case "deepseek":
			return "deepseek";
		case "lmstudio":
			return "lmstudio";
		case "llama-server":
			return "llama-server";
		case "ollama":
		case "8gent":
			return "ollama"; // 8gent runs on the local ollama server today
		// SPEC-05 #108 dispatcher parity: Anthropic speaks the native Messages API,
		// not the OpenAI Chat-Completions shape, so it must NOT fold onto the
		// OpenRouter runtime. Route it to its own client (parallels the correct
		// Anthropic branch in `ProviderManager.chat`).
		case "anthropic":
			return "anthropic";
		case "openrouter":
		case "groq":
		case "grok":
		case "openai":
		case "mistral":
		case "together":
		case "fireworks":
		case "replicate":
			return "openrouter";
	}
	// Not a compiled name. Either a provider declared in ~/.8gent/providers.json,
	// whose `compat` picks the wire shape, or a name we know nothing about -
	// which keeps the old fall-through to the local ollama runtime.
	const compat = getProviderManager().getProvider(provider).compat;
	return compat ? runtimeForCompat(compat) : "ollama";
}

/**
 * Create the appropriate LLM client based on agent config
 */
export function createClient(config: AgentConfig): LLMClient {
	// `config.baseUrl` is threaded to every HTTP client that accepts one. Passing
	// `undefined` is a no-op: each client falls back to its env/default base URL.
	if (config.runtime === "openrouter") {
		const apiKey = config.apiKey || process.env.OPENROUTER_API_KEY || "";
		// OpenRouterClient is the generic OpenAI Chat-Completions client and
		// appends "/chat/completions", so a declared base URL SHOULD carry its
		// own "/v1" suffix. Undefined keeps the OpenRouter default.
		return new OpenRouterClient(config.model, apiKey, config.baseUrl);
	}
	if (config.runtime === "anthropic") {
		const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY || "";
		return new AnthropicClient(config.model, apiKey);
	}
	if (config.runtime === "lmstudio") {
		// LMStudioClient appends "/v1/chat/completions" to baseUrl, so the base
		// must NOT include a "/v1" suffix (e.g. "http://127.0.0.1:1234").
		return new LMStudioClient(config.model, config.baseUrl);
	}
	if (config.runtime === "llama-server") {
		// llama-server speaks the same OpenAI API; the LM Studio client is the
		// generic one (it appends "/v1/chat/completions" to a root URL).
		return new LMStudioClient(config.model, config.baseUrl ?? resolveLlamaServerUrl());
	}
	if (config.runtime === "apple-foundation") {
		// No baseUrl: this client spawns the apple-foundation-bridge subprocess
		// and talks JSON-lines over stdio, not HTTP. A custom base URL cannot
		// apply. (The 2nd arg is an optional bridge *binary path*, not a URL.)
		return new AppleFoundationClient(config.model);
	}
	if (config.runtime === "apfel") {
		// ApfelClient appends "/chat/completions", so baseUrl SHOULD include the
		// "/v1" suffix (e.g. "http://127.0.0.1:11435/v1").
		return new ApfelClient(config.model, config.baseUrl);
	}
	if (config.runtime === "deepseek") {
		const apiKey = config.apiKey || process.env.DEEPSEEK_API_KEY || "";
		return new DeepSeekClient(config.model, apiKey);
	}
	return new OllamaClient(config.model, config.baseUrl);
}

/**
 * Build an `LLMClient` for a specific role (orchestrator, engineer, qa).
 *
 * Reads `~/.8gent/roles.json`, picks the role's assignment, merges any
 * caller-supplied override, then hands off to the existing `createClient()`
 * factory. Throws `RoleProviderUnavailableError` if the chosen provider's
 * `enabled` flag is false on this host so callers can show an install
 * wizard rather than silently falling back.
 */
export function createClientForRole(
	role: RoleName,
	override?: Partial<RoleModelAssignment>,
): LLMClient {
	const cfg = loadRoleConfig();
	const assignment: RoleModelAssignment = { ...cfg[role], ...override };

	const pm = getProviderManager();
	const providerCfg = pm.getProvider(assignment.provider);
	if (!providerCfg.enabled) {
		throw new RoleProviderUnavailableError(role, assignment.provider);
	}

	const apiKey = pm.getApiKey(assignment.provider) || undefined;
	const runtime = runtimeForProvider(assignment.provider);
	return createClient({
		runtime,
		model: assignment.model,
		apiKey,
		// Only a DECLARED provider's base URL is threaded. The built-ins keep
		// their client-side defaults on purpose: those do not all agree with
		// `ProviderConfig.baseUrl` (lmstudio's registry entry carries a "/v1"
		// suffix the client appends itself), so passing theirs through would
		// double the suffix and break a provider that works today.
		baseUrl: providerCfg.declared ? providerCfg.baseUrl : undefined,
	});
}
