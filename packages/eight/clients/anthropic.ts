/**
 * Anthropic client (native Messages API).
 *
 * SPEC-05 #108 dispatcher parity: the role/`createClient` path used to fold
 * `anthropic` onto the OpenRouter runtime, which speaks the OpenAI
 * Chat-Completions shape and cannot reach `api.anthropic.com` directly. This
 * client mirrors `ProviderManager.chatAnthropic` so a role configured for
 * `anthropic` builds a real Anthropic client instead of an OpenRouter one.
 *
 * Talks the native Messages API at `https://api.anthropic.com/v1/messages`
 * (system prompt hoisted out of the message list, `x-api-key` +
 * `anthropic-version` headers, `tool_use` content blocks). Reads
 * `ANTHROPIC_API_KEY`; never logs the key.
 */

import type { LLMClient, LLMResponse, Message, MessageContent } from "../types";

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

function flattenContent(content: MessageContent): string {
	if (typeof content === "string") return content;
	return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

/** Convert an OpenAI-style tool definition to the Anthropic tool shape. */
function toAnthropicTool(tool: any): Record<string, unknown> {
	const fn = tool?.function ?? tool;
	return {
		name: fn?.name,
		description: fn?.description,
		input_schema: fn?.parameters ?? { type: "object", properties: {} },
	};
}

export class AnthropicClient implements LLMClient {
	private baseUrl: string;
	private model: string;
	private apiKey: string;

	constructor(model?: string, apiKey?: string, baseUrl?: string) {
		this.model = model || "claude-3-5-sonnet-latest";
		this.baseUrl = baseUrl || process.env.ANTHROPIC_BASE_URL || DEFAULT_BASE_URL;
		this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY || "";
		if (!this.apiKey) {
			throw new Error(
				"Anthropic client requires ANTHROPIC_API_KEY. Set it in the environment " +
					"or configure it via /settings.",
			);
		}
	}

	private headers(): Record<string, string> {
		return {
			"Content-Type": "application/json",
			"x-api-key": this.apiKey,
			"anthropic-version": ANTHROPIC_VERSION,
		};
	}

	async chat(messages: Message[], tools?: object[]): Promise<LLMResponse> {
		// Anthropic carries the system prompt out-of-band, not as a message.
		const systemMessage = messages.find((m) => m.role === "system");
		const otherMessages = messages.filter((m) => m.role !== "system");

		const body: Record<string, unknown> = {
			model: this.model,
			max_tokens: 4096,
			messages: otherMessages.map((m) => ({
				role: m.role === "assistant" ? "assistant" : "user",
				content: flattenContent(m.content),
			})),
		};
		if (systemMessage) {
			body.system = flattenContent(systemMessage.content);
		}
		if (tools && tools.length > 0) {
			body.tools = tools.map(toAnthropicTool);
		}

		const response = await fetch(`${this.baseUrl}/messages`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			const safeText = errorText.replace(this.apiKey, "[REDACTED]");
			throw new Error(
				`Anthropic error: ${response.status} ${response.statusText} - ${safeText}`,
			);
		}

		const data = await response.json();

		let content = "";
		const toolCalls: NonNullable<LLMResponse["message"]["tool_calls"]> = [];
		for (const block of data.content || []) {
			if (block.type === "text") {
				content += block.text;
			} else if (block.type === "tool_use") {
				toolCalls.push({
					function: {
						name: block.name,
						// LLMResponse carries tool arguments as a JSON string, matching
						// the OpenAI-compatible clients.
						arguments: JSON.stringify(block.input ?? {}),
					},
				});
			}
		}

		return {
			model: data.model || this.model,
			message: {
				role: "assistant",
				content,
				tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
			},
			done: true,
			usage: data.usage
				? {
						prompt_tokens: data.usage.input_tokens || 0,
						completion_tokens: data.usage.output_tokens || 0,
						total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
					}
				: undefined,
		};
	}

	async generate(prompt: string): Promise<string> {
		const response = await this.chat([{ role: "user", content: prompt }]);
		return response.message.content;
	}

	async isAvailable(): Promise<boolean> {
		return this.apiKey.length > 0;
	}
}
