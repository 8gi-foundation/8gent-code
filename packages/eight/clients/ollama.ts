/**
 * Ollama LLM Client
 */

import type { Message, LLMResponse, LLMClient } from "../types";

/**
 * Resolve the Ollama base URL, checking for MetaClaw proxy override.
 * When MetaClaw is running, requests route through its proxy for
 * skill injection and RL training signal collection.
 */
function resolveBaseUrl(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.METACLAW_PROXY_URL) return process.env.METACLAW_PROXY_URL;
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
