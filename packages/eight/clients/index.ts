/**
 * LLM Client Factory & Exports
 */

import {
	type RoleModelAssignment,
	type RoleName,
	loadRoleConfig,
} from "../../orchestration/role-config";
import { type ProviderName, getProviderManager } from "../../providers";
import type { AgentConfig, LLMClient } from "../types";
import { ApfelClient } from "./apfel";
import { AppleFoundationClient } from "./apple-foundation";
import { DeepSeekClient } from "./deepseek";
import { LMStudioClient } from "./lmstudio";
import { OllamaClient } from "./ollama";
import { OpenRouterClient } from "./openrouter";

export { OllamaClient } from "./ollama";
export { LMStudioClient } from "./lmstudio";
export { OpenRouterClient } from "./openrouter";
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
		super(
			`Provider "${provider}" required for role "${role}" is not available on this host`,
		);
		this.name = "RoleProviderUnavailableError";
	}
}

/**
 * Map a `ProviderName` to the `AgentConfig.runtime` literal understood by
 * `createClient()`. Providers that don't map to a runtime fall through to
 * the OpenRouter path since those are all OpenAI-compatible HTTP APIs.
 */
function runtimeForProvider(provider: ProviderName): AgentConfig["runtime"] {
	switch (provider) {
		case "apple-foundation":
			return "apple-foundation";
		case "apfel":
			return "apfel";
		case "deepseek":
			return "deepseek";
		case "ollama":
		case "8gent":
			return "ollama"; // 8gent runs on the local ollama server today
		case "openrouter":
		case "groq":
		case "grok":
		case "openai":
		case "anthropic":
		case "mistral":
		case "together":
		case "fireworks":
		case "replicate":
			return "openrouter";
		default:
			return "ollama";
	}
}

/**
 * Create the appropriate LLM client based on agent config
 */
export function createClient(config: AgentConfig): LLMClient {
	if (config.runtime === "openrouter") {
		const apiKey = config.apiKey || process.env.OPENROUTER_API_KEY || "";
		return new OpenRouterClient(config.model, apiKey);
	}
	if (config.runtime === "lmstudio") {
		return new LMStudioClient(config.model);
	}
	if (config.runtime === "apple-foundation") {
		return new AppleFoundationClient(config.model);
	}
	if (config.runtime === "apfel") {
		return new ApfelClient(config.model);
	}
	if (config.runtime === "deepseek") {
		const apiKey = config.apiKey || process.env.DEEPSEEK_API_KEY || "";
		return new DeepSeekClient(config.model, apiKey);
	}
	return new OllamaClient(config.model);
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
	});
}
