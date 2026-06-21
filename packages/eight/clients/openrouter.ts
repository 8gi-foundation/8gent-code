/**
 * OpenRouter LLM Client (OpenAI-compatible)
 *
 * CLOUD client. `chat()` is wrapped by the PII gate (`./pii-gate`): outbound
 * messages are anonymized + verified clean before they leave the machine, and
 * the cloud response (content + tool-call arguments) is de-anonymized on the
 * way back. On any anonymizer failure or surviving PII we FAIL CLOSED - reroute
 * to a local Ollama model, or refuse - and never send raw to OpenRouter.
 */

import type { LLMClient, LLMResponse, Message } from "../types";
import { anonymizeOutbound, deanonymizeResponse, resolveLocalFallback } from "./pii-gate";

export class OpenRouterClient implements LLMClient {
	private baseUrl: string;
	private model: string;
	private apiKey: string;

	constructor(model: string, apiKey: string, baseUrl = "https://openrouter.ai/api/v1") {
		this.model = model;
		this.baseUrl = baseUrl;
		this.apiKey = apiKey;
	}

	async chat(messages: Message[], tools?: object[]): Promise<LLMResponse> {
		// ── PII gate (cloud-egress boundary) ────────────────────────────────
		// HARD RULE: no PII may reach OpenRouter. Anonymize + verify before send;
		// de-anonymize the reply. Fail closed to a local model on any failure.
		const gate = anonymizeOutbound(messages);
		if (!gate.clean) {
			const local = resolveLocalFallback();
			if (!local) {
				throw new Error(
					"PII gate fail-closed (OpenRouter): could not produce a verified-clean " +
						"payload and no local provider is available. Refusing to send to cloud.",
				);
			}
			// Local path: the ORIGINAL (un-anonymized) messages stay on-device.
			return local.chat(messages, tools);
		}

		const response = await this.chatRaw(gate.messages, tools);
		return deanonymizeResponse(response, gate.map);
	}

	/** Raw cloud dispatch. Callers must pass already-gated (pseudonymized) messages. */
	private async chatRaw(messages: Message[], tools?: object[]): Promise<LLMResponse> {
		const body: Record<string, unknown> = {
			model: this.model,
			messages: messages.map((m) => ({
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
				Authorization: `Bearer ${this.apiKey}`,
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
		const response = await this.chat([{ role: "user", content: prompt }]);
		return response.message.content;
	}

	async isAvailable(): Promise<boolean> {
		try {
			const response = await fetch(`${this.baseUrl}/models`, {
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
				},
			});
			return response.ok;
		} catch {
			return false;
		}
	}
}
