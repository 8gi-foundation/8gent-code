/**
 * Ollama LLM Client
 */

import type { Message, LLMResponse, LLMClient } from "../types";

/**
 * Resolve the Ollama base URL, checking for training proxy override.
 * When the training proxy is running, requests route through it for
 * skill injection and RL training signal collection.
 */
function resolveBaseUrl(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.TRAINING_PROXY_URL) return process.env.TRAINING_PROXY_URL;

  // Check .8gent/config.json for training_proxy.proxyUrl
  try {
    const configPath = `${process.cwd()}/.8gent/config.json`;
    const config = JSON.parse(require("fs").readFileSync(configPath, "utf-8"));
    if (config.training_proxy?.enabled && config.training_proxy?.proxyUrl) {
      return config.training_proxy.proxyUrl;
    }
  } catch {
    // Config not found or invalid — fall through
  }

  return "http://localhost:11434";
}

export class OllamaClient implements LLMClient {
  private baseUrl: string;
  private model: string;

  constructor(model: string, baseUrl?: string) {
    this.model = model;
    this.baseUrl = resolveBaseUrl(baseUrl);
  }

  async chat(messages: Message[], tools?: object[]): Promise<LLMResponse> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
        tools,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.statusText}`);
    }

    const data = await response.json();

    return {
      ...data,
      usage: {
        prompt_tokens: data.prompt_eval_count,
        completion_tokens: data.eval_count,
        total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
        prompt_eval_count: data.prompt_eval_count,
        eval_count: data.eval_count,
      },
    };
  }

  async generate(prompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.response;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
