/**
 * 8gent AI - Provider Configuration
 *
 * Uses @ai-sdk/openai-compatible to create providers for
 * Ollama, LM Studio, and OpenRouter.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

export type ProviderName = "ollama" | "lmstudio" | "openrouter";

export interface ProviderConfig {
  name: ProviderName;
  model: string;
  baseURL?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

const DEFAULT_URLS: Record<ProviderName, string> = {
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

/**
 * Create a language model from provider config.
 * This is the single entry point for getting an AI SDK model.
 *
 * For OpenRouter free models: uses intelligent retry with exponential
 * backoff (2s, 4s, 8s, 16s, 32s) and up to 8 attempts. Free models
 * allow 1000 calls/day but have per-minute rate limits.
 */
export function createModel(config: ProviderConfig): LanguageModel {
  const baseURL = config.baseURL || DEFAULT_URLS[config.name];
  const isFreeModel = config.model.includes(":free") || config.name === "openrouter";

  const provider = createOpenAICompatible({
    name: config.name,
    baseURL,
    apiKey: config.apiKey || getApiKeyFromEnv(config.name),
    headers: {
      ...config.headers,
      ...(config.name === "openrouter"
        ? {
            "HTTP-Referer": "https://8gent.app",
            "X-Title": "8gent Code",
          }
        : {}),
    },
  });

  return provider(config.model);
}

/**
 * Get retry config for free models.
 * Free models allow 1000 calls/day but have per-minute rate limits.
 * Use exponential backoff: 2s, 4s, 8s, 16s, 32s across 8 attempts.
 */
export function getRetryConfig(config: ProviderConfig): { maxRetries: number } {
  const isFreeModel = config.model.includes(":free");
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
  }
}

/**
 * Check if a provider is available by hitting its models endpoint.
 */
export async function isProviderAvailable(config: ProviderConfig): Promise<boolean> {
  const baseURL = config.baseURL || DEFAULT_URLS[config.name];
  try {
    const response = await fetch(`${baseURL.replace("/v1", "")}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    }).catch(() =>
      fetch(`${baseURL}/models`, {
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
        signal: AbortSignal.timeout(3000),
      })
    );
    return response.ok;
  } catch {
    return false;
  }
}
