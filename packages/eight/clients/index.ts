/**
 * LLM Client Factory & Exports
 */

import type { AgentConfig, LLMClient } from "../types";
import { OllamaClient } from "./ollama";
import { LMStudioClient } from "./lmstudio";
import { OpenRouterClient } from "./openrouter";
import { AppleFoundationClient } from "./apple-foundation";

export { OllamaClient } from "./ollama";
export { LMStudioClient } from "./lmstudio";
export { OpenRouterClient } from "./openrouter";
export { AppleFoundationClient } from "./apple-foundation";

/**
 * Create the appropriate LLM client based on agent config
 */
export function createClient(config: AgentConfig): LLMClient {
  if (config.runtime === "openrouter") {
    const apiKey = config.apiKey || process.env.OPENROUTER_API_KEY || "";
    return new OpenRouterClient(config.model, apiKey);
  } else if (config.runtime === "lmstudio") {
    return new LMStudioClient(config.model);
  } else if (config.runtime === "apple-foundation") {
    return new AppleFoundationClient(config.model);
  } else {
    return new OllamaClient(config.model);
  }
}
