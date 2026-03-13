/**
 * OpenRouter LLM Client (OpenAI-compatible)
 */

import type { Message, LLMResponse, LLMClient } from "../types";

export class OpenRouterClient implements LLMClient {
  private baseUrl: string;
  private model: string;
  private apiKey: string;

  constructor(model: string, apiKey: string, baseUrl: string = "https://openrouter.ai/api/v1") {
    this.model = model;
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async chat(messages: Message[], tools?: object[]): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      stream: false,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
        "HTTP-Referer": "https://8gent.app",
        "X-Title": "8gent Code",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter error: ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();

    return {
      model: data.model || this.model,
      message: {
        role: data.choices?.[0]?.message?.role || "assistant",
        content: data.choices?.[0]?.message?.content || "",
        tool_calls: data.choices?.[0]?.message?.tool_calls?.map((tc: any) => ({
          function: {
            name: tc.function?.name,
            arguments: tc.function?.arguments,
          },
        })),
      },
      done: true,
      usage: data.usage ? {
        prompt_tokens: data.usage.prompt_tokens,
        completion_tokens: data.usage.completion_tokens,
        total_tokens: data.usage.total_tokens,
      } : undefined,
    };
  }

  async generate(prompt: string): Promise<string> {
    const response = await this.chat([{ role: "user", content: prompt }]);
    return response.message.content;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
