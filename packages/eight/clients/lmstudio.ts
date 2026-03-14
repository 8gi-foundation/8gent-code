/**
 * LM Studio LLM Client (OpenAI-compatible)
 */

import type { Message, LLMResponse, LLMClient } from "../types";

export class LMStudioClient implements LLMClient {
  private baseUrl: string;
  private model: string;
  private apiKey: string;

  constructor(model: string, baseUrl: string = "http://localhost:1234", apiKey: string = "lm-studio") {
    this.model = model;
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async chat(messages: Message[], tools?: object[]): Promise<LLMResponse> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
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
      const errorText = await response.text();
      throw new Error(`LM Studio error: ${response.statusText} - ${errorText}`);
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
    const response = await fetch(`${this.baseUrl}/v1/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`LM Studio error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.text || "";
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
        },
      });
      if (!response.ok) return [];
      const data = await response.json();
      return data.data?.map((m: any) => m.id) || [];
    } catch {
      return [];
    }
  }
}
