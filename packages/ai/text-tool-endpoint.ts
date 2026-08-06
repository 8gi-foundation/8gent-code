/**
 * 8gent AI - Text-Tool Provider Endpoint Helper
 *
 * Shared glue for driving a tool-incapable local model agentically through the
 * text tool-call protocol. Factors the pieces that bin/8gent.ts and
 * packages/eight/agent.ts both need so neither has to duplicate them:
 *
 *  - TEXT_TOOL_ENDPOINTS: the per-provider OpenAI-compatible chat-completions URL.
 *  - buildTextToolCall: a `call` function (the kind runTextToolAgent wants) that
 *    POSTs the conversation to that endpoint with NO native `tools` payload (the
 *    whole point - the model's served template 400s on a tools field), then
 *    returns the assistant text.
 *  - toolDefsToTextTools: convert OpenAI-style function definitions (the shape
 *    ToolExecutor.getToolDefinitions returns) into runTextToolAgent's
 *    {spec, run} tools, wiring `run` to a real executor.
 *
 * This module performs no I/O of its own beyond the fetch inside the returned
 * `call`; the tool `run`s do whatever their injected executor does.
 */

import type { ToolSpec } from "./text-tools";
import type { TextTool } from "./text-tool-loop";

/** Per-provider OpenAI-compatible chat-completions endpoints for text tools. */
export const TEXT_TOOL_ENDPOINTS: Record<string, string> = {
	lmstudio: "http://localhost:1234/v1/chat/completions",
	ollama: "http://localhost:11434/v1/chat/completions",
	// apfel fronts Apple Foundation over an OpenAI-compatible server. The live
	// Table roster runs it on :11435, and its base already carries "/v1" (unlike
	// lmstudio/ollama), so the default here is the full completions URL. Without
	// this entry apfel fell through to the lmstudio default (:1234).
	apfel: "http://127.0.0.1:11435/v1/chat/completions",
};

/**
 * Normalise ANY on-box backend base URL to its `/v1/chat/completions` endpoint,
 * reconciling the three base conventions the local backends use so a URL is
 * never double-suffixed:
 *   - host only        "http://h:11434"       -> + "/v1/chat/completions"  (ollama)
 *   - lmstudio host    "http://h:1234"         -> + "/v1/chat/completions"
 *   - host + "/v1"     "http://h:11435/v1"     -> + "/chat/completions"     (apfel)
 *   - already full     ".../chat/completions"  -> unchanged
 * Pure and deterministic.
 */
export function toChatCompletionsEndpoint(base: string): string {
	const trimmed = base.trim().replace(/\/+$/, "");
	if (/\/chat\/completions$/.test(trimmed)) return trimmed;
	if (/\/v1$/.test(trimmed)) return `${trimmed}/chat/completions`;
	return `${trimmed}/v1/chat/completions`;
}

/**
 * Normalise a base URL to its OpenAI-compatible `/v1` root - the shape the AI
 * SDK's `createOpenAICompatible` wants (it appends `/chat/completions` itself).
 * The mirror of toChatCompletionsEndpoint for the native (non-text-tool) path,
 * so a per-session baseUrl in ANY convention reaches the AI SDK correctly:
 *   - host only        "http://h:11434"       -> + "/v1"      (ollama, lmstudio)
 *   - host + "/v1"     "http://h:11435/v1"     -> unchanged    (apfel)
 *   - full completions ".../v1/chat/completions" -> "/v1"
 * Never double-suffixes "/v1".
 */
export function toOpenAiV1Base(base: string): string {
	const trimmed = base
		.trim()
		.replace(/\/+$/, "")
		.replace(/\/chat\/completions$/, "");
	if (/\/v1$/.test(trimmed)) return trimmed;
	return `${trimmed}/v1`;
}

/**
 * Resolve a provider's text-tool endpoint. When a per-session `baseUrl` is
 * given (an officer pinned to a specific local port), it WINS and is normalised
 * to its chat-completions endpoint (suffix-reconciled) regardless of provider;
 * otherwise the per-provider default applies, falling back to LM Studio's.
 */
export function resolveTextToolEndpoint(provider: string, baseUrl?: string): string {
	if (baseUrl && baseUrl.trim()) return toChatCompletionsEndpoint(baseUrl);
	return TEXT_TOOL_ENDPOINTS[provider] || TEXT_TOOL_ENDPOINTS.lmstudio;
}

type ChatMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
};

/** Real token usage reported by the endpoint for one completion. */
export type TextToolUsage = {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
};

/**
 * Extract REAL usage from an OpenAI-compatible completion response (#2805).
 * Both ollama and LM Studio report `usage.{prompt,completion,total}_tokens` on
 * /v1/chat/completions. Returns null - never invented numbers - when the
 * response omits usage or the fields are not finite numbers. When `total` is
 * absent but both parts are real, the total is their sum (arithmetic on real
 * numbers, not fabrication).
 */
export function extractUsage(data: unknown): TextToolUsage | null {
	const u = (data as { usage?: unknown } | null)?.usage;
	if (typeof u !== "object" || u === null) return null;
	const rec = u as Record<string, unknown>;
	const num = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) ? v : null;
	const prompt = num(rec.prompt_tokens);
	const completion = num(rec.completion_tokens);
	const total = num(rec.total_tokens);
	if (total !== null) {
		return { promptTokens: prompt ?? 0, completionTokens: completion ?? 0, totalTokens: total };
	}
	if (prompt !== null && completion !== null) {
		return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
	}
	return null;
}

/**
 * Build a `call` function for runTextToolAgent that hits a local provider's
 * OpenAI-compatible /v1/chat/completions endpoint. Sends NO `tools` field so a
 * GGUF chat template that rejects native tool calling never 400s. Returns the
 * assistant message text (empty string when the provider returns no content).
 * Rejects (so the loop's caller can fall back) when the endpoint errors.
 *
 * Pass `signal` to make the underlying fetch abortable: a stalled local model
 * (socket accepted, no body) is then torn down when the caller aborts (turn
 * timeout, circuit breaker, user ESC) instead of leaving the request - and the
 * turn - hung forever.
 */
export function buildTextToolCall(opts: {
	provider: string;
	model: string;
	endpoint?: string;
	/**
	 * Per-session base URL (an officer pinned to a specific local port). When set
	 * and no explicit `endpoint` is given, it is suffix-reconciled to the correct
	 * `/v1/chat/completions` URL and wins over the per-provider default.
	 */
	baseUrl?: string;
	temperature?: number;
	signal?: AbortSignal;
	/**
	 * Fired once per completed call with the REAL usage the endpoint reported
	 * (#2805). Never fired when the endpoint omits usage - no fabricated tokens.
	 */
	onUsage?: (usage: TextToolUsage) => void;
}): (messages: ChatMessage[]) => Promise<string> {
	const endpoint = opts.endpoint || resolveTextToolEndpoint(opts.provider, opts.baseUrl);
	const temperature = opts.temperature ?? 0.2;

	return async (messages: ChatMessage[]): Promise<string> => {
		const res = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: opts.model,
				messages,
				temperature,
				stream: false,
			}),
			signal: opts.signal,
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(
				`${opts.provider} chat completions ${res.status}: ${body.slice(0, 300)}`,
			);
		}
		const data = (await res.json()) as {
			choices?: Array<{ message?: { content?: unknown } }>;
			usage?: unknown;
		};
		if (opts.onUsage) {
			const usage = extractUsage(data);
			if (usage) opts.onUsage(usage);
		}
		const content = data?.choices?.[0]?.message?.content;
		return typeof content === "string" ? content : "";
	};
}

// The OpenAI-style function-definition shape ToolExecutor.getToolDefinitions
// emits: { type: "function", function: { name, description, parameters } }.
type OpenAiToolDef = {
	type?: string;
	function?: {
		name?: unknown;
		description?: unknown;
		parameters?: unknown;
	};
};

/**
 * Derive a ToolSpec from one OpenAI-style function definition. Returns null when
 * the def lacks a usable string name (those are skipped by the caller).
 */
export function toolDefToSpec(def: OpenAiToolDef): ToolSpec | null {
	const fn = def?.function;
	if (!fn || typeof fn.name !== "string" || fn.name.length === 0) return null;
	const parameters =
		typeof fn.parameters === "object" && fn.parameters !== null
			? (fn.parameters as Record<string, unknown>)
			: { type: "object", properties: {} };
	return {
		name: fn.name,
		description: typeof fn.description === "string" ? fn.description : "",
		parameters,
	};
}

/**
 * Convert OpenAI-style tool definitions into ToolSpecs, filtered to `allow`
 * (when given). Definitions without a usable name are skipped. Use this when
 * the caller wires its own `run` per spec (the agent path does, so it can emit
 * lifecycle events around each call); use toolDefsToTextTools when a single
 * shared `execute` is enough.
 */
export function toolDefsToSpecs(
	defs: OpenAiToolDef[],
	allow?: Set<string>,
): ToolSpec[] {
	const specs: ToolSpec[] = [];
	for (const def of defs) {
		const spec = toolDefToSpec(def);
		if (!spec) continue;
		if (allow && !allow.has(spec.name)) continue;
		specs.push(spec);
	}
	return specs;
}

/**
 * Convert OpenAI-style tool definitions into runTextToolAgent {spec, run}
 * tools. Only definitions whose name is in `allow` are kept (when `allow` is
 * given), and `run(args)` is wired to the injected `execute`, which must be the
 * REAL tool executor (file/command/git tools that honour the working
 * directory), not a read-only demo. Definitions without a usable name are
 * skipped.
 */
export function toolDefsToTextTools(
	defs: OpenAiToolDef[],
	execute: (name: string, args: Record<string, unknown>) => Promise<string>,
	allow?: Set<string>,
): TextTool[] {
	return toolDefsToSpecs(defs, allow).map((spec) => ({
		spec,
		run: (args: Record<string, unknown>) => execute(spec.name, args),
	}));
}
