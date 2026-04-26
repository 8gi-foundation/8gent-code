/**
 * apfel client.
 *
 * apfel exposes Apple Foundation chat at a Chat Completions API style
 * endpoint on `localhost`. Apple Silicon + macOS 26 Tahoe only. No vision.
 *
 * Default base URL is `http://localhost:11434/v1` which collides with the
 * Ollama default port. Run apfel on a different port (e.g. 11500) when
 * Ollama is also running. See `docs/MODELS.md` for the recommended split.
 *
 * v1: non-streaming + streaming over the SSE shape, no tool calling,
 * no vision. Vision-bearing prompts are rejected up-front with a clear error.
 */

import type { LLMClient, LLMResponse, Message, MessageContent } from "../types";

const DEFAULT_BASE_URL = "http://localhost:11434/v1";
const INSTALL_HINT =
	"apfel is not running. Install: https://github.com/Arthur-Ficial/apfel " +
	"(MIT, Apple Silicon, macOS 26 Tahoe+). Start it with " +
	"`apfel serve --port 11500` and set `APFEL_BASE_URL=http://localhost:11500/v1` " +
	"to avoid colliding with Ollama's default 11434.";

function resolveBaseUrl(explicit?: string): string {
	if (explicit) return explicit;
	if (process.env.APFEL_BASE_URL) return process.env.APFEL_BASE_URL;
	return DEFAULT_BASE_URL;
}

function flattenContent(content: MessageContent): string {
	if (typeof content === "string") return content;
	return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

function hasVisionPart(content: MessageContent): boolean {
	if (typeof content === "string") return false;
	return content.some((part) => part.type === "image_url");
}

function rejectIfVision(messages: Message[]): void {
	for (const m of messages) {
		if (hasVisionPart(m.content)) {
			throw new Error(
				"apfel: Apple Foundation has no vision support. Route vision-bearing " +
					"prompts to the vision tier (Qwen 3.6-27B) instead.",
			);
		}
	}
}

export class ApfelClient implements LLMClient {
	private baseUrl: string;
	private model: string;

	constructor(model: string, baseUrl?: string) {
		this.model = model || "apple-foundationmodel";
		this.baseUrl = resolveBaseUrl(baseUrl);
	}

	async chat(messages: Message[], tools?: object[]): Promise<LLMResponse> {
		rejectIfVision(messages);

		const body: Record<string, unknown> = {
			model: this.model,
			messages: messages.map((m) => ({
				role: m.role,
				content: flattenContent(m.content),
			})),
			stream: false,
		};
		if (tools && tools.length > 0) {
			// Pass-through for forward compat. Apple Foundation v1 ignores tools.
			body.tools = tools;
		}

		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		} catch (err) {
			throw new Error(`apfel: ${INSTALL_HINT} (cause: ${(err as Error).message})`);
		}

		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			throw new Error(`apfel error: ${response.status} ${response.statusText} - ${errorText}`);
		}

		const data = await response.json();

		return {
			model: data.model || this.model,
			message: {
				role: data.choices?.[0]?.message?.role || "assistant",
				content: data.choices?.[0]?.message?.content || "",
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
		rejectIfVision(messages);

		const body = {
			model: this.model,
			messages: messages.map((m) => ({
				role: m.role,
				content: flattenContent(m.content),
			})),
			stream: true,
		};

		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		} catch (err) {
			throw new Error(`apfel: ${INSTALL_HINT} (cause: ${(err as Error).message})`);
		}

		if (!response.ok || !response.body) {
			throw new Error(`apfel stream error: ${response.status} ${response.statusText}`);
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
						// Ignore non-JSON keep-alive lines.
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
		try {
			const response = await fetch(`${this.baseUrl}/models`);
			return response.ok;
		} catch {
			return false;
		}
	}
}
