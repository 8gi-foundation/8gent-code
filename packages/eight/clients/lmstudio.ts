/**
 * LM Studio LLM Client (OpenAI-compatible)
 */

import type { LLMClient, LLMResponse, Message } from "../types";

export class LMStudioClient implements LLMClient {
	private baseUrl: string;
	private model: string;
	private apiKey: string;
	/**
	 * Output token budget sent as `max_tokens`. Reasoning models (e.g.
	 * ornith-1.0-9b) spend tokens on a hidden thinking trace BEFORE emitting the
	 * visible answer; with no ceiling LM Studio's own default can cut them off
	 * mid-thought and `content` comes back empty. A generous default keeps the
	 * final answer landing in `content`. Configurable via the constructor arg or
	 * the `LM_STUDIO_MAX_TOKENS` env var. Non-reasoning models are unaffected -
	 * they simply never approach the ceiling.
	 */
	private maxTokens: number;

	constructor(
		model: string,
		baseUrl: string = process.env.LM_STUDIO_HOST || "http://localhost:1234",
		apiKey = "lm-studio",
		maxTokens: number = Number(process.env.LM_STUDIO_MAX_TOKENS) || 4000,
	) {
		this.model = model;
		this.baseUrl = baseUrl;
		this.apiKey = apiKey;
		this.maxTokens = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 4000;
	}

	async chat(messages: Message[], tools?: object[]): Promise<LLMResponse> {
		const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: this.model,
				messages: messages.map((m) => ({
					role: m.role,
					content: m.content,
				})),
				tools,
				max_tokens: this.maxTokens,
				stream: false,
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`LM Studio error: ${response.statusText} - ${errorText}`);
		}

		const data = await response.json();

		const choice = data.choices?.[0];
		const message = choice?.message ?? {};
		const finishReason: string = choice?.finish_reason ?? "";

		// Reasoning models keep the visible answer in `content` but the hidden
		// thinking trace in `reasoning_content`. Read `content` first; fall back
		// to `reasoning_content` ONLY when content is empty/whitespace, so a normal
		// (non-reasoning) model's real content is never overridden.
		const rawContent = typeof message.content === "string" ? message.content : "";
		const rawReasoning =
			typeof message.reasoning_content === "string" ? message.reasoning_content : "";
		const contentIsEmpty = rawContent.trim().length === 0;

		// A reasoning model whose token budget ran out mid-thought returns empty
		// content with finish_reason "length". Its `reasoning_content` is then a
		// TRUNCATED hidden chain-of-thought, never a final answer - surfacing it as
		// the reply would be silent garbage, so fail loudly instead of returning it.
		if (contentIsEmpty && finishReason === "length") {
			throw new Error(
				`LM Studio model "${this.model}" hit the ${this.maxTokens}-token limit before ` +
					`emitting an answer (finish_reason=length, content empty). Raise maxTokens ` +
					`(constructor arg or LM_STUDIO_MAX_TOKENS) for this reasoning model.`,
			);
		}

		const content = contentIsEmpty ? rawReasoning : rawContent;

		return {
			model: data.model || this.model,
			message: {
				role: message.role || "assistant",
				content,
				tool_calls: message.tool_calls?.map((tc: any) => ({
					function: {
						name: tc.function?.name,
						arguments: tc.function?.arguments,
					},
				})),
			},
			done: true,
			usage: data.usage
				? {
						prompt_tokens: data.usage.prompt_tokens,
						completion_tokens: data.usage.completion_tokens,
						total_tokens: data.usage.total_tokens,
					}
				: undefined,
		};
	}

	async generate(prompt: string): Promise<string> {
		const response = await fetch(`${this.baseUrl}/v1/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: this.model,
				prompt,
				max_tokens: this.maxTokens,
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
					Authorization: `Bearer ${this.apiKey}`,
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
					Authorization: `Bearer ${this.apiKey}`,
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
