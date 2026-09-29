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

import { modelFetch } from "./model-fetch";
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
 * Ollama runs the model's built-in output parser (e.g. `PARSER qwen3.5` for
 * qwen3.8) on EVERY /v1/chat/completions and /api/chat reply, even when the
 * request carries no `tools`. When a model drifts out of our fenced
 * ```tool_call protocol into its own native `<tool_call>` markup, that parser
 * tries to read the body as its XML `<function=...>` format, `xml.Unmarshal`
 * fails, and Ollama turns the whole reply into a 500 whose message is the Go
 * XML error: `EOF`, `unexpected EOF`, or `XML syntax error ...` (Ollama 0.34.4,
 * model/parsers/qwen3coder.go parseToolCall; seen live in Rishi's pilot,
 * 2026-09-29). The chat endpoints have no switch to turn that parser off, so
 * the reply is gone; the only recovery is to ask again.
 */
const NATIVE_PARSER_ERROR_RE = /^(?:unexpected EOF|EOF|XML syntax error\b.*)$/;

/**
 * True when an HTTP failure is Ollama's built-in tool-call parser rejecting the
 * model's reply (see NATIVE_PARSER_ERROR_RE). Narrow on purpose: only provider
 * "ollama", only status 500, only an error message that is exactly one of the
 * Go XML decoder's failures. Pure.
 */
export function isNativeToolParserFailure(
	provider: string,
	status: number,
	body: string,
): boolean {
	if (provider !== "ollama" || status !== 500) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return false;
	}
	const error = (parsed as { error?: unknown } | null)?.error;
	const message =
		typeof error === "string"
			? error
			: typeof error === "object" && error !== null
				? (error as { message?: unknown }).message
				: undefined;
	return typeof message === "string" && NATIVE_PARSER_ERROR_RE.test(message.trim());
}

/**
 * True when Ollama answered 200 but its built-in parser silently swallowed the
 * reply: the model generated tokens, yet `content` is empty. Seen live on
 * qwen3.8 when a reply held an unclosed native tool-call tag, or its reasoning
 * mentioned one: everything after the tag went into the parser's tool buffer
 * and was never flushed. Only for provider "ollama", and only when the endpoint
 * reported real completion tokens (never guessed). Pure.
 */
export function isSwallowedReply(
	provider: string,
	content: string,
	completionTokens: number,
): boolean {
	return provider === "ollama" && content.trim() === "" && completionTokens > 0;
}

/**
 * The one-shot reminder sent when Ollama's built-in parser rejected a reply.
 * It points the model back at the fenced block and deliberately never spells
 * out the native tag, so it cannot prime the very markup that failed.
 */
export const NATIVE_TOOL_MARKUP_REMINDER = [
	"Your previous reply could not be delivered: it used the model's built-in",
	"tool-call tags, which this runtime cannot accept. Reply again.",
	"To call a tool, use ONLY a fenced block that opens with ```tool_call and",
	"holds one JSON object, exactly as the instructions show. If you do not need",
	"a tool, reply in plain prose with no tags or markup.",
].join("\n");

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
 *
 * The request never inherits Bun's hidden 300 s fetch cap: it goes through
 * modelFetch, whose limit is `timeoutMs` (default: EIGHT_TURN_TIMEOUT_MS via
 * resolveTurnTimeoutMs). A step that runs past it rejects with TurnTimeoutError.
 *
 * On provider "ollama" it retries ONCE, with NATIVE_TOOL_MARKUP_REMINDER
 * appended to a copy of the conversation, when Ollama's built-in tool-call
 * parser ate the reply: a parser 500 (isNativeToolParserFailure) or an empty
 * 200 for generated tokens (isSwallowedReply). See #3012.
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
	 * Limit for one model step in ms. Default: resolveTurnTimeoutMs(), so
	 * EIGHT_TURN_TIMEOUT_MS governs. Injectable so tests need not wait minutes.
	 */
	timeoutMs?: number;
	/**
	 * Fired once per completed call with the REAL usage the endpoint reported
	 * (#2805). Never fired when the endpoint omits usage - no fabricated tokens.
	 */
	onUsage?: (usage: TextToolUsage) => void;
}): (messages: ChatMessage[]) => Promise<string> {
	const endpoint = opts.endpoint || resolveTextToolEndpoint(opts.provider, opts.baseUrl);
	const temperature = opts.temperature ?? 0.2;

	const post = (messages: ChatMessage[]) =>
		modelFetch(
			endpoint,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: opts.model,
					messages,
					temperature,
					stream: false,
				}),
				signal: opts.signal,
			},
			{ timeoutMs: opts.timeoutMs, label: `${opts.provider}/${opts.model}` },
		);

	// One completion: POST, surface a non-2xx as an error, report real usage,
	// and return the assistant text alongside what we need to judge the reply.
	const attempt = async (
		messages: ChatMessage[],
	): Promise<
		| { ok: true; content: string; completionTokens: number }
		| { ok: false; status: number; body: string }
	> => {
		const res = await post(messages);
		if (!res.ok) {
			return { ok: false, status: res.status, body: await res.text().catch(() => "") };
		}
		const data = (await res.json()) as {
			choices?: Array<{ message?: { content?: unknown } }>;
			usage?: unknown;
		};
		const usage = extractUsage(data);
		if (usage && opts.onUsage) opts.onUsage(usage);
		const content = data?.choices?.[0]?.message?.content;
		return {
			ok: true,
			content: typeof content === "string" ? content : "",
			completionTokens: usage?.completionTokens ?? 0,
		};
	};

	return async (messages: ChatMessage[]): Promise<string> => {
		const first = await attempt(messages);
		if (first.ok) {
			if (!isSwallowedReply(opts.provider, first.content, first.completionTokens)) {
				return first.content;
			}
		} else if (!isNativeToolParserFailure(opts.provider, first.status, first.body)) {
			throw new Error(
				`${opts.provider} chat completions ${first.status}: ${first.body.slice(0, 300)}`,
			);
		}

		// Ollama's built-in parser ate the reply, loudly (500) or silently (empty
		// 200). Ask exactly once more, on a copy of the conversation plus a
		// reminder. Never more than one retry per call.
		const retry = await attempt([
			...messages,
			{ role: "user", content: NATIVE_TOOL_MARKUP_REMINDER },
		]);
		if (retry.ok) return retry.content;
		throw new Error(
			`${opts.provider} chat completions ${retry.status}: the model replied in native ` +
				`tool-call markup that ${opts.provider}'s built-in tool-call parser rejected; ` +
				`retried once with a format reminder and it failed again: ${retry.body.slice(0, 300)}`,
		);
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
