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
	/**
	 * Ceiling on a single request. Without one, a socket that accepts and never
	 * answers hangs for as long as the caller allows - observed as five-minute
	 * dead air per message when LM Studio was listening but not serving.
	 * `LM_STUDIO_TIMEOUT_MS`, default 120s.
	 */
	private timeoutMs: number;
	/** Readiness probes must fail fast; a slow probe is a failed probe. */
	private probeTimeoutMs: number;
	/** Probe budget: enough for a reasoning model to think AND emit a token. */
	private probeMaxTokens: number;

	constructor(
		model: string,
		baseUrl: string = process.env.LM_STUDIO_HOST || "http://localhost:1234",
		apiKey = "lm-studio",
		maxTokens: number = Number(process.env.LM_STUDIO_MAX_TOKENS) || 4000,
		timeoutMs: number = Number(process.env.LM_STUDIO_TIMEOUT_MS) || 120_000,
	) {
		this.model = model;
		this.baseUrl = baseUrl;
		this.apiKey = apiKey;
		this.maxTokens = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 4000;
		this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000;
		this.probeTimeoutMs = Number(process.env.LM_STUDIO_PROBE_TIMEOUT_MS) || 30_000;
		this.probeMaxTokens = Number(process.env.LM_STUDIO_PROBE_MAX_TOKENS) || 512;
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
			// Bounded on purpose. An endpoint that accepts the socket and never
			// answers previously hung until the caller's own timeout, spending the
			// entire budget on a request that was never going to complete.
			signal: AbortSignal.timeout(this.timeoutMs),
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

	/**
	 * LIVENESS only: is something listening and serving the model list?
	 *
	 * This does NOT mean the model can answer. On 2026-08-27 `/v1/models`
	 * returned 200 listing `ornith-1.0-9b` while `/v1/chat/completions` timed
	 * out after 300000ms, five times over three and a half hours. Every message
	 * in that window burned the full provider timeout, and this method reported
	 * healthy throughout.
	 *
	 * Use {@link isReady} before routing real traffic. Reach for this only when
	 * the question genuinely is "is the server process up".
	 */
	async isAvailable(): Promise<boolean> {
		try {
			const response = await fetch(`${this.baseUrl}/v1/models`, {
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
				},
				signal: AbortSignal.timeout(this.probeTimeoutMs),
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	/**
	 * READINESS: can the model actually produce a token right now?
	 *
	 * Sends one real, token-capped completion and asserts non-empty content came
	 * back. A server that accepts connections, lists models and then never
	 * answers is the failure this catches and {@link isAvailable} cannot.
	 *
	 * Returns a reason rather than a bare boolean so a caller - a watchdog, a
	 * failover router - can log WHY it was not ready and decide whether to
	 * restart, wait, or fail over. Never throws.
	 */
	async isReady(): Promise<{ ready: boolean; reason?: string; latencyMs: number }> {
		const started = Date.now();
		const elapsed = () => Date.now() - started;
		try {
			const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify({
					model: this.model,
					messages: [{ role: "user", content: "ok" }],
					// Generous enough that a reasoning model can finish thinking and
					// still emit a token. Too low and every reasoning model looks
					// permanently unready, which is worse than no probe at all.
					max_tokens: this.probeMaxTokens,
					stream: false,
				}),
				signal: AbortSignal.timeout(this.probeTimeoutMs),
			});

			if (!response.ok) {
				return { ready: false, reason: `http ${response.status}`, latencyMs: elapsed() };
			}

			const data = await response.json();
			const choice = data.choices?.[0];
			const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
			const finishReason: string = choice?.finish_reason ?? "";

			if (content.trim().length === 0) {
				// The server answered, so it is live - but it produced nothing
				// usable. Reported as not-ready on purpose: this is exactly the
				// state that looks healthy and serves no one.
				return {
					ready: false,
					reason:
						finishReason === "length"
							? "empty content, reasoning budget exhausted"
							: `empty content (finish_reason=${finishReason || "unknown"})`,
					latencyMs: elapsed(),
				};
			}

			return { ready: true, latencyMs: elapsed() };
		} catch (err) {
			const timedOut = err instanceof Error && err.name === "TimeoutError";
			const msg = err instanceof Error ? err.message : String(err);
			return {
				ready: false,
				reason: timedOut ? `probe timed out after ${this.probeTimeoutMs}ms` : msg,
				latencyMs: elapsed(),
			};
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
