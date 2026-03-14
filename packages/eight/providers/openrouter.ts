/**
 * OpenRouter Provider for 8gent
 *
 * Supports both free and paid models via OpenRouter API.
 * Free models include: Qwen3, GPT-OSS 120B, and the free model router.
 *
 * Based on: https://openrouter.ai/docs
 */

export interface OpenRouterModel {
  id: string;
  name: string;
  pricing: {
    prompt: string;
    completion: string;
  };
  context_length: number;
  top_provider?: {
    context_length: number;
    is_moderated: boolean;
  };
}

export interface OpenRouterConfig {
  apiKey: string;
  baseUrl?: string;
  freeOnly?: boolean;
}

// Known free models on OpenRouter (as of March 2026)
export const FREE_MODELS = [
  "openrouter/auto", // Free model router
  "qwen/qwen3-coder-480b:free",
  "qwen/qwen3-30b-a3b:free",
  "nvidia/llama-3.1-nemotron-70b-instruct:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "deepseek/deepseek-r1:free",
  "google/gemma-2-9b-it:free",
  "mistralai/mistral-7b-instruct:free",
];

// Default free model router - automatically routes to available free models
export const DEFAULT_FREE_MODEL = "openrouter/auto";

export class OpenRouterProvider {
  private apiKey: string;
  private baseUrl: string;
  private freeOnly: boolean;

  constructor(config: OpenRouterConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || "https://openrouter.ai/api/v1";
    this.freeOnly = config.freeOnly ?? false;
  }

  /**
   * Fetch available models from OpenRouter
   */
  async getModels(): Promise<OpenRouterModel[]> {
    const response = await fetch(`${this.baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const data = await response.json();
    let models = data.data as OpenRouterModel[];

    // Filter to free models if requested
    if (this.freeOnly) {
      models = models.filter(
        (m) =>
          m.pricing.prompt === "0" ||
          m.pricing.prompt === "$0" ||
          m.id.includes(":free") ||
          FREE_MODELS.includes(m.id)
      );
    }

    return models;
  }

  /**
   * Get free models only
   */
  async getFreeModels(): Promise<OpenRouterModel[]> {
    const models = await this.getModels();
    return models.filter(
      (m) =>
        m.pricing.prompt === "0" ||
        m.pricing.prompt === "$0" ||
        m.id.includes(":free") ||
        FREE_MODELS.includes(m.id)
    );
  }

  /**
   * Generate a chat completion
   */
  async chat(
    model: string,
    messages: Array<{ role: string; content: string }>,
    options?: {
      temperature?: number;
      maxTokens?: number;
      stream?: boolean;
    }
  ): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://8gent.app",
        "X-Title": "8gent Code",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? 4096,
        stream: options?.stream ?? false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(`OpenRouter error: ${data.error.message}`);
    }

    return data.choices[0].message.content;
  }

  /**
   * Test connection to OpenRouter
   */
  async testConnection(): Promise<boolean> {
    try {
      const models = await this.getModels();
      return models.length > 0;
    } catch {
      return false;
    }
  }
}

/**
 * Get environment config for OpenRouter integration with Claude Code
 *
 * This generates the settings.json content needed to use OpenRouter
 * as documented in the Claude Code docs.
 */
export function getOpenRouterConfig(apiKey: string, model: string = DEFAULT_FREE_MODEL): Record<string, string> {
  return {
    OPENROUTER_API_KEY: apiKey,
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1",
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_API_KEY: "", // Must be explicitly empty
    ANTHROPIC_MODEL: model,
  };
}

/**
 * Format onboarding message for OpenRouter
 */
export function getOpenRouterOnboardingMessage(): string {
  return `
╭───────────────────────────────────────────────────────────╮
│  🆓 OpenRouter Free Models                                │
├───────────────────────────────────────────────────────────┤
│                                                           │
│  OpenRouter provides access to FREE AI models:            │
│                                                           │
│  • Qwen 3 Coder (480B) - Great for coding                 │
│  • GPT-OSS 120B - General purpose                         │
│  • Llama 3.3 70B - Fast and capable                       │
│  • DeepSeek R1 - Reasoning focused                        │
│  • Free Model Router - Auto-selects best available        │
│                                                           │
│  No GPU needed! Models run in the cloud.                  │
│                                                           │
│  Setup:                                                   │
│  1. Create account at openrouter.ai                       │
│  2. Generate API key (free)                               │
│  3. Enter key when prompted                               │
│                                                           │
╰───────────────────────────────────────────────────────────╯
`;
}

export default OpenRouterProvider;
