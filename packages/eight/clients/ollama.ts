/**
 * Ollama LLM Client
 */

import type { LLMClient, LLMResponse, Message, MessageContentPart } from "../types";

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
		const config = JSON.parse(require("node:fs").readFileSync(configPath, "utf-8"));
		if (config.training_proxy?.enabled && config.training_proxy?.proxyUrl) {
			return config.training_proxy.proxyUrl;
		}
	} catch {
		// Config not found or invalid — fall through
	}

	return "http://localhost:11434";
}

/**
 * Flatten a message for Ollama's API.
 *
 * Ollama's /api/chat expects `content` to be a plain string. For vision-capable
 * models it also accepts an `images` array of raw base64 strings (no data URL
 * prefix). OpenAI-style array content (content: [{type, text}, {type, image_url}])
 * is NOT supported and returns a 400 Bad Request.
 *
 * - Text-only messages: content stays a string.
 * - Array messages: text parts joined, image_url base64 payloads moved to `images`.
 */
function flattenMessage(m: Message): object {
	if (typeof m.content === "string") {
		return { role: m.role, content: m.content };
	}
	const parts = m.content as MessageContentPart[];
	const text = parts
		.filter((p) => p.type === "text")
		.map((p) => p.text ?? "")
		.join("\n");
	const images = parts
		.filter((p) => p.type === "image_url")
		.map((p) => {
			const url = (p as any).image_url?.url ?? "";
			// Strip "data:image/...;base64," prefix Ollama doesn't want
			const m = url.match(/^data:[^;]+;base64,(.+)$/s);
			return m ? m[1] : url;
		});
	const out: Record<string, unknown> = { role: m.role, content: text };
	if (images.length > 0) out.images = images;
	return out;
}

export class OllamaClient implements LLMClient {
	private baseUrl: string;
	private model: string;

	constructor(model: string, baseUrl?: string) {
		this.model = model;
		this.baseUrl = resolveBaseUrl(baseUrl);
	}

	async chat(messages: Message[], tools?: object[]): Promise<LLMResponse> {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), 180_000); // 180s — covers cold-start for large models (27B+)

		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}/api/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: this.model,
					messages: messages.map(flattenMessage),
					tools,
					stream: false,
				}),
				signal: ac.signal,
			});
		} catch (err: any) {
			clearTimeout(timer);
			if (err?.name === "AbortError") throw new Error("Ollama error: request timed out after 180s");
			throw err;
		}
		clearTimeout(timer);

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
