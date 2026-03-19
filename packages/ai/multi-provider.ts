/**
 * 8gent AI - Multi-Provider LLM Engine
 *
 * OpenViktor-inspired unified multi-provider engine with automatic fallback,
 * cost tracking, and session budgeting. Supports Ollama, Anthropic, OpenAI,
 * and OpenRouter as providers.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── Types ───────────────────────────────────────────

export type Provider = "ollama" | "anthropic" | "openai" | "openrouter";

export interface CompletionOptions {
  model?: string;
  provider?: Provider;
  temperature?: number;
  maxTokens?: number;
  /** Maximum cost in USD for this request. Skips providers that would exceed it. */
  costLimit?: number;
}

export interface CompletionResult {
  text: string;
  model: string;
  provider: Provider;
  tokens: {
    prompt: number;
    completion: number;
  };
  cost: number;
  durationMs: number;
}

export interface CostReport {
  period: string;
  totalCost: number;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
  requestCount: number;
  totalTokens: { prompt: number; completion: number };
}

interface CostEntry {
  timestamp: string;
  provider: Provider;
  model: string;
  cost: number;
  promptTokens: number;
  completionTokens: number;
}

interface ProviderEndpoint {
  baseURL: string;
  apiKeyEnv: string;
  defaultModel: string;
  requiresKey: boolean;
}

// ── Constants ───────────────────────────────────────

const COST_DIR = join(homedir(), ".8gent");
const COST_FILE = join(COST_DIR, "costs.json");

const PROVIDER_CONFIG: Record<Provider, ProviderEndpoint> = {
  ollama: {
    baseURL: "http://localhost:11434/v1",
    apiKeyEnv: "",
    defaultModel: "qwen2.5-coder:7b",
    requiresKey: false,
  },
  anthropic: {
    baseURL: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-20250514",
    requiresKey: true,
  },
  openai: {
    baseURL: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-4o",
    requiresKey: true,
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultModel: "anthropic/claude-sonnet-4-20250514",
    requiresKey: true,
  },
};

/** Approximate cost per 1K tokens (prompt, completion) in USD */
const MODEL_COSTS: Record<string, { prompt: number; completion: number }> = {
  // Ollama — free (local)
  "qwen2.5-coder:7b": { prompt: 0, completion: 0 },
  "llama3.1:8b": { prompt: 0, completion: 0 },
  "deepseek-coder-v2:16b": { prompt: 0, completion: 0 },
  // Anthropic
  "claude-sonnet-4-20250514": { prompt: 0.003, completion: 0.015 },
  "claude-haiku-3-20250314": { prompt: 0.00025, completion: 0.00125 },
  // OpenAI
  "gpt-4o": { prompt: 0.005, completion: 0.015 },
  "gpt-4o-mini": { prompt: 0.00015, completion: 0.0006 },
  // OpenRouter (varies, using common defaults)
  "anthropic/claude-sonnet-4-20250514": { prompt: 0.003, completion: 0.015 },
  "google/gemini-flash-1.5": { prompt: 0.000075, completion: 0.0003 },
};

// ── Default fallback order ──────────────────────────

const DEFAULT_FALLBACK_CHAIN: Provider[] = [
  "ollama",
  "openrouter",
  "anthropic",
  "openai",
];

// ── Multi-Provider Engine ───────────────────────────

export class MultiProviderEngine {
  private fallbackChain: Provider[];

  constructor(fallbackChain?: Provider[]) {
    this.fallbackChain = fallbackChain || DEFAULT_FALLBACK_CHAIN;
  }

  /**
   * Run a completion across providers with automatic fallback.
   * Tries the preferred provider first, then falls back through the chain.
   */
  async complete(
    prompt: string,
    options: CompletionOptions = {}
  ): Promise<CompletionResult> {
    const chain = options.provider
      ? [options.provider, ...this.fallbackChain.filter((p) => p !== options.provider)]
      : this.fallbackChain;

    const errors: Array<{ provider: Provider; error: string }> = [];

    for (const provider of chain) {
      const config = PROVIDER_CONFIG[provider];

      // Check if provider requires an API key and it's available
      if (config.requiresKey && !process.env[config.apiKeyEnv]) {
        errors.push({ provider, error: `Missing ${config.apiKeyEnv}` });
        continue;
      }

      // Check if local provider is reachable
      if (provider === "ollama") {
        const available = await this.checkOllamaAvailable();
        if (!available) {
          errors.push({ provider, error: "Ollama not running" });
          continue;
        }
      }

      const model = options.model || config.defaultModel;

      // Check cost limit
      if (options.costLimit) {
        const estimatedCost = this.estimateCost(model, prompt.length / 4, options.maxTokens || 1000);
        if (estimatedCost > options.costLimit) {
          errors.push({ provider, error: `Estimated cost $${estimatedCost.toFixed(4)} exceeds limit $${options.costLimit}` });
          continue;
        }
      }

      try {
        const result = await this.callProvider(provider, model, prompt, options);
        this.recordCost(result);
        return result;
      } catch (err: any) {
        errors.push({ provider, error: err.message });
        continue;
      }
    }

    throw new Error(
      `All providers failed:\n${errors.map((e) => `  ${e.provider}: ${e.error}`).join("\n")}`
    );
  }

  /**
   * Get a cost report for a given time period.
   */
  getCostReport(period: "today" | "week" | "month" | "all" = "all"): CostReport {
    const entries = this.loadCostEntries();
    const now = new Date();
    let since: Date;

    switch (period) {
      case "today":
        since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case "week":
        since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case "month":
        since = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case "all":
        since = new Date(0);
        break;
    }

    const filtered = entries.filter(
      (e) => new Date(e.timestamp) >= since
    );

    const byProvider: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    let totalCost = 0;
    let totalPrompt = 0;
    let totalCompletion = 0;

    for (const entry of filtered) {
      totalCost += entry.cost;
      totalPrompt += entry.promptTokens;
      totalCompletion += entry.completionTokens;
      byProvider[entry.provider] = (byProvider[entry.provider] || 0) + entry.cost;
      byModel[entry.model] = (byModel[entry.model] || 0) + entry.cost;
    }

    return {
      period,
      totalCost,
      byProvider,
      byModel,
      requestCount: filtered.length,
      totalTokens: { prompt: totalPrompt, completion: totalCompletion },
    };
  }

  // ── Private Methods ─────────────────────────────

  private async callProvider(
    provider: Provider,
    model: string,
    prompt: string,
    options: CompletionOptions
  ): Promise<CompletionResult> {
    const config = PROVIDER_CONFIG[provider];
    const apiKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;

    const startTime = Date.now();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (apiKey) {
      if (provider === "anthropic") {
        headers["x-api-key"] = apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
    }

    if (provider === "openrouter") {
      headers["HTTP-Referer"] = "https://8gent.app";
      headers["X-Title"] = "8gent Code";
    }

    let body: any;
    let url: string;

    if (provider === "anthropic") {
      url = `${config.baseURL}/messages`;
      body = {
        model,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature ?? 0.7,
        messages: [{ role: "user", content: prompt }],
      };
    } else {
      url = `${config.baseURL}/chat/completions`;
      body = {
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens || 4096,
      };
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${provider} API error (${response.status}): ${errorText.slice(0, 200)}`);
    }

    const data = await response.json();
    const durationMs = Date.now() - startTime;

    // Normalize response across providers
    let text: string;
    let promptTokens: number;
    let completionTokens: number;

    if (provider === "anthropic") {
      text = data.content?.[0]?.text || "";
      promptTokens = data.usage?.input_tokens || 0;
      completionTokens = data.usage?.output_tokens || 0;
    } else {
      text = data.choices?.[0]?.message?.content || "";
      promptTokens = data.usage?.prompt_tokens || 0;
      completionTokens = data.usage?.completion_tokens || 0;
    }

    const cost = this.calculateCost(model, promptTokens, completionTokens);

    return {
      text,
      model,
      provider,
      tokens: { prompt: promptTokens, completion: completionTokens },
      cost,
      durationMs,
    };
  }

  private async checkOllamaAvailable(): Promise<boolean> {
    try {
      const response = await fetch("http://localhost:11434/api/tags", {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private estimateCost(model: string, estimatedPromptTokens: number, estimatedCompletionTokens: number): number {
    const costs = MODEL_COSTS[model] || { prompt: 0.001, completion: 0.003 };
    return (
      (estimatedPromptTokens / 1000) * costs.prompt +
      (estimatedCompletionTokens / 1000) * costs.completion
    );
  }

  private calculateCost(model: string, promptTokens: number, completionTokens: number): number {
    const costs = MODEL_COSTS[model] || { prompt: 0.001, completion: 0.003 };
    return (
      (promptTokens / 1000) * costs.prompt +
      (completionTokens / 1000) * costs.completion
    );
  }

  private recordCost(result: CompletionResult): void {
    const entries = this.loadCostEntries();
    entries.push({
      timestamp: new Date().toISOString(),
      provider: result.provider,
      model: result.model,
      cost: result.cost,
      promptTokens: result.tokens.prompt,
      completionTokens: result.tokens.completion,
    });

    if (!existsSync(COST_DIR)) {
      mkdirSync(COST_DIR, { recursive: true });
    }

    writeFileSync(COST_FILE, JSON.stringify(entries, null, 2), "utf-8");
  }

  private loadCostEntries(): CostEntry[] {
    if (!existsSync(COST_FILE)) return [];
    try {
      return JSON.parse(readFileSync(COST_FILE, "utf-8"));
    } catch {
      return [];
    }
  }
}
