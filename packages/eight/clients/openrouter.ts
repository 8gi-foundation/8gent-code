/**
 * OpenRouter LLM Client (OpenAI-compatible)
 *
 * The generic OpenAI Chat-Completions client. It defaults to OpenRouter, but
 * `createClient()` also routes providers declared in `~/.8gent/providers.json`
 * here with their own base URL, so the destination is whatever that URL says.
 *
 * CLOUD-BOUND requests are wrapped by the PII gate (`./pii-gate`): outbound
 * messages are anonymized + verified clean before they leave the machine, and
 * the cloud response (content + tool-call arguments) is de-anonymized on the
 * way back. On any anonymizer failure or surviving PII we FAIL CLOSED - reroute
 * to a local Ollama model, or refuse - and never send raw to the cloud.
 *
 * An ON-DEVICE base URL bypasses the gate entirely, exactly as the registry
 * stack does: the data never leaves the machine, so there is nothing to
 * anonymize, and pseudonymizing a coding agent's file paths would corrupt them.
 */

import { isCloudProvider } from "../../providers";
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
		// A declared provider can point this client at an on-device endpoint. The
		// data then never leaves the machine, so there is no egress boundary to
		// gate - and anonymizing would hand the model pseudonymized file paths
		// and identifiers, which for a coding agent is a correctness hazard, not
		// a safety win. Same base-URL test the registry stack applies, so the two
		// stacks agree on what counts as local.
		if (!isCloudProvider({ baseUrl: this.baseUrl })) {
			return this.chatRaw(messages, tools);
		}

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
		// A hosted endpoint with no key gets no request at all (#3746).
		if (this.hostedWithoutKey()) {
			throw new Error(
				"No API key for openrouter, so nothing was sent to the hosted endpoint. Set OPENROUTER_API_KEY to use it, or pick a local provider.",
			);
		}
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

	/** True when this client points at a hosted endpoint and has no key (#3746). */
	private hostedWithoutKey(): boolean {
		return !this.apiKey?.trim() && isCloudProvider({ baseUrl: this.baseUrl });
	}

	async isAvailable(): Promise<boolean> {
		if (this.hostedWithoutKey()) return false;
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
