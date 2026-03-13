/**
 * LLM Client Factory & Exports
 */

import type { AgentConfig, LLMClient } from "../types";
import { OllamaClient } from "./ollama";
import { LMStudioClient } from "./lmstudio";
import { OpenRouterClient } from "./openrouter";

export { OllamaClient } from "./ollama";
export { LMStudioClient } from "./lmstudio";
export { OpenRouterClient } from "./openrouter";

/**
 * Create the appropriate LLM client based on agent config
 */
export function createClient(config: AgentConfig): LLMClient {
  if (config.runtime === "openrouter") {
    const apiKey = config.apiKey || process.env.OPENROUTER_API_KEY || "";
    return new OpenRouterClient(config.model, apiKey);
  } else if (config.runtime === "lmstudio") {
    return new LMStudioClient(config.model);
  } else {
    return new OllamaClient(config.model);
  }
}
