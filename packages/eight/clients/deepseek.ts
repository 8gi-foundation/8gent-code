/**
 * DeepSeek client.
 *
 * Heavy cloud fallback for the failover chain. Direct API at
 * `https://api.deepseek.com/v1` (Chat Completions API style). DeepSeek V4-Flash is the
 * routine fallback. V4-Pro is flagged-only (set `DEEPSEEK_USE_PRO=1`) to keep
 * the default tier predictable.
 *
 * Reads `DEEPSEEK_API_KEY`. Never logs the key. Throws a clear error if unset
 * so callers can route to the next tier in the failover chain.
 */

import type { LLMClient, LLMResponse, Message, MessageContent } from "../types";

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

export const DEEPSEEK_FLASH = "deepseek-v4-flash";
export const DEEPSEEK_PRO = "deepseek-v4-pro";

function flattenContent(content: MessageContent): string {
	if (typeof content === "string") return content;
	return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

function resolveBaseUrl(explicit?: string): string {
	if (explicit) return explicit;
	if (process.env.DEEPSEEK_BASE_URL) return process.env.DEEPSEEK_BASE_URL;
	return DEFAULT_BASE_URL;
}

function resolveModel(explicit?: string): string {
	if (explicit) return explicit;
	if (process.env.DEEPSEEK_USE_PRO === "1") return DEEPSEEK_PRO;
	return DEEPSEEK_FLASH;
}

export class DeepSeekClient implements LLMClient {
	private baseUrl: string;
	private model: string;
	private apiKey: string;

	constructor(model?: string, apiKey?: string, baseUrl?: string) {
		this.model = resolveModel(model);
		this.baseUrl = resolveBaseUrl(baseUrl);
		this.apiKey = apiKey || process.env.DEEPSEEK_API_KEY || "";
		if (!this.apiKey) {
			throw new Error(
				"DeepSeek client requires DEEPSEEK_API_KEY. Set it in the environment " +
					"or pass it explicitly. Get a key at https://platform.deepseek.com.",
			);
		}
	}

	private headers(): Record<string, string> {
		return {
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.apiKey}`,
		};
	}

	async chat(messages: Message[], tools?: object[]): Promise<LLMResponse> {
		const body: Record<string, unknown> = {
			model: this.model,
			messages: messages.map((m) => ({
				role: m.role,
				content: flattenContent(m.content),
			})),
			stream: false,
		};
		if (tools && tools.length > 0) {
			body.tools = tools;
		}

		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			// Strip any echoed key material defensively before surfacing the error.
			const safeText = errorText.replace(this.apiKey, "[REDACTED]");
			throw new Error(`DeepSeek error: ${response.status} ${response.statusText} - ${safeText}`);
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

	async *stream(messages: Message[]): AsyncGenerator<string> {
		const body = {
			model: this.model,
			messages: messages.map((m) => ({
				role: m.role,
				content: flattenContent(m.content),
			})),
			stream: true,
		};

		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
		});
		if (!response.ok || !response.body) {
			throw new Error(`DeepSeek stream error: ${response.status} ${response.statusText}`);
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let idx = buffer.indexOf("\n");
			while (idx !== -1) {
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (line.startsWith("data:")) {
					const payload = line.slice(5).trim();
					if (payload === "[DONE]") return;
					try {
						const parsed = JSON.parse(payload);
						const delta = parsed.choices?.[0]?.delta?.content;
						if (delta) yield delta as string;
					} catch {
						// Skip non-JSON SSE keepalives.
					}
				}
				idx = buffer.indexOf("\n");
			}
		}
	}

	async generate(prompt: string): Promise<string> {
		const response = await this.chat([{ role: "user", content: prompt }]);
		return response.message.content;
	}

	async isAvailable(): Promise<boolean> {
		if (!this.apiKey) return false;
		try {
			const response = await fetch(`${this.baseUrl}/models`, {
				headers: { Authorization: `Bearer ${this.apiKey}` },
			});
			return response.ok;
		} catch {
			return false;
		}
	}
}
