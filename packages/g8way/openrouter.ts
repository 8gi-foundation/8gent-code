/**
 * @8gent/g8way - OpenRouter client.
 *
 * Thin wrapper around `fetch` to OpenRouter's OpenAI-compatible endpoint.
 * Two reasons it's a class instead of a free function:
 *   1. Tests inject a fake `fetchImpl` to avoid hitting the network.
 *   2. The base URL + headers are session-scoped (one client per server).
 *
 * No retry logic here on purpose: the daemon's existing `failover.ts`
 * handles retries upstream and we don't want to double up.
 */

import type { OpenAIChatRequest } from "./types";

export interface OpenRouterClientOptions {
	apiKey: string;
	baseUrl: string;
	fetchImpl?: typeof fetch;
	/** Optional referer/title for OpenRouter analytics. */
	referer?: string;
	title?: string;
}

export interface UpstreamResponse {
	status: number;
	headers: Headers;
	body: ReadableStream<Uint8Array> | null;
	json?: unknown;
}

export class OpenRouterClient {
	private fetchImpl: typeof fetch;

	constructor(private opts: OpenRouterClientOptions) {
		this.fetchImpl = opts.fetchImpl ?? fetch;
	}

	private headers(): Record<string, string> {
		const h: Record<string, string> = {
			"content-type": "application/json",
			authorization: `Bearer ${this.opts.apiKey}`,
		};
		if (this.opts.referer) h["http-referer"] = this.opts.referer;
		if (this.opts.title) h["x-title"] = this.opts.title;
		return h;
	}

	async chatCompletions(req: OpenAIChatRequest): Promise<UpstreamResponse> {
		const res = await this.fetchImpl(`${this.opts.baseUrl}/chat/completions`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(req),
		});

		if (req.stream) {
			return {
				status: res.status,
				headers: res.headers,
				body: res.body,
			};
		}

		const json = await res.json();
		return {
			status: res.status,
			headers: res.headers,
			body: null,
			json,
		};
	}
}
