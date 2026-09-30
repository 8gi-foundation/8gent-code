/**
 * 8gent AI - Text-Tool Provider Endpoint Helper
 *
 * Shared glue for driving a tool-incapable local model agentically through the
 * text tool-call protocol. Factors the pieces that bin/8gent.ts and
 * packages/eight/agent.ts both need so neither has to duplicate them:
 *
 *  - TEXT_TOOL_ENDPOINTS: the per-provider OpenAI-compatible chat-completions URL.
 *  - buildTextToolCall: a `call` function (the kind runTextToolAgent wants) that
 *    POSTs the conversation to that endpoint, then returns the assistant text
 *    (plus any structured `tool_calls`). No native `tools` payload by default -
 *    some served GGUF templates 400 on a tools field; Ollama is the exception
 *    (see shouldDeclareTools).
 *  - toolDefsToTextTools: convert OpenAI-style function definitions (the shape
 *    ToolExecutor.getToolDefinitions returns) into runTextToolAgent's
 *    {spec, run} tools, wiring `run` to a real executor.
 *
 * This module performs no I/O of its own beyond the fetch inside the returned
 * `call`; the tool `run`s do whatever their injected executor does.
 */

import {
	DEFAULT_OLLAMA_BASE_URL,
	normaliseOllamaHost,
	resolveOllamaBaseUrl,
} from "../local-model-server/ollama-host";
import { resolveLlamaServerUrl } from "../local-model-server/select";
import { modelFetch } from "./model-fetch";
import type { TextToolReply } from "./text-tool-client";
import { escapeControlCharsInStrings, type ParsedToolCall, type ToolSpec } from "./text-tools";
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
	// Ollama honours the standard env vars (#3076). Without this the TUI sent
	// every step to localhost:11434 even with OLLAMA_HOST pointing elsewhere.
	if (provider === "ollama") return toChatCompletionsEndpoint(resolveOllamaBaseUrl());
	if (provider === "llama-server") return toChatCompletionsEndpoint(resolveLlamaServerUrl());
	return TEXT_TOOL_ENDPOINTS[provider] || TEXT_TOOL_ENDPOINTS.lmstudio;
}

// The one Ollama host resolver lives in the local model server layer (#3149);
// re-exported here so every existing import keeps working.
export { DEFAULT_OLLAMA_BASE_URL, normaliseOllamaHost, resolveOllamaBaseUrl };

/** Default output budget for one text-tool model step (#3074). */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/**
 * Output token budget for one text-tool model step, sent as `max_tokens` (and
 * `num_predict` on Ollama's raw path). Without it a small model that falls into
 * a repetition loop generates until its context window fills: llama3.2:3b ran
 * 41,341 tokens in 13 minutes on one step, and the non-streaming request showed
 * the user "0 tok" the whole time (#3074). EIGHT_MAX_OUTPUT_TOKENS overrides;
 * anything that is not a positive number falls back to the default.
 */
export function resolveMaxOutputTokens(
	env: Record<string, string | undefined> = process.env,
): number {
	const parsed = Number(env.EIGHT_MAX_OUTPUT_TOKENS);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_OUTPUT_TOKENS;
	return Math.floor(parsed);
}

/**
 * Ollama models that must answer with thinking OFF, from EIGHT_OLLAMA_NO_THINK
 * (comma-separated model names, e.g. "qwen3.5:9b"). A helper that thinks
 * before every tool call is slower and can burn the output cap on reasoning.
 * Ollama 0.34.4 ignores `think:false` on /v1/chat/completions but honours
 * `reasoning_effort: "none"` (qwen3.5:9b: 0 reasoning chars, measured).
 * Unset means no model is changed. Pure.
 */
export function isOllamaNoThink(
	provider: string,
	model: string,
	env: Record<string, string | undefined> = process.env,
): boolean {
	if (provider !== "ollama") return false;
	const list = (env.EIGHT_OLLAMA_NO_THINK ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return list.includes(model);
}

/** The error a step gets when the model hit the output cap without finishing. */
export function outputCapMessage(label: string, maxTokens: number): string {
	return `${label} hit the ${maxTokens}-token output cap without finishing its reply (likely a runaway repetition loop). Raise EIGHT_MAX_OUTPUT_TOKENS if the reply was genuinely that long.`;
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
 * 2026-09-29). Proven against qwen3.8:27b-mlx on 2026-09-30: the same reply
 * 500s with `EOF` on /v1/chat/completions, /api/chat AND /api/generate, and
 * none of them has a switch to turn the parser off. Only `/api/generate` with
 * `raw: true` skips it and returns the text untouched, so that is the recovery
 * path (see buildTextToolCall).
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
 * Convert an OpenAI-shape `message.tool_calls` array into parsed calls, in
 * order. Each entry is `{ function: { name, arguments } }` where `arguments` is
 * a JSON string (OpenAI, Ollama /v1) or already an object (Ollama /api/chat).
 * An entry without a string name, or whose arguments are neither an object nor
 * a JSON string holding one, is skipped. Does NOT filter by registered tools:
 * runTextToolTurn does that, since only it knows the tool set. Pure, never
 * throws.
 */
export function toolCallsFromMessage(message: unknown): ParsedToolCall[] {
	const list = (message as { tool_calls?: unknown } | null | undefined)?.tool_calls;
	if (!Array.isArray(list)) return [];
	const calls: ParsedToolCall[] = [];
	for (const entry of list) {
		const fn = (entry as { function?: { name?: unknown; arguments?: unknown } } | null)?.function;
		if (!fn || typeof fn.name !== "string" || fn.name === "") continue;
		const args = structuredArguments(fn.arguments);
		if (args === null) continue;
		calls.push({ name: fn.name, arguments: args });
	}
	return calls;
}

function structuredArguments(raw: unknown): Record<string, unknown> | null {
	if (raw === undefined || raw === null || raw === "") return {};
	const isObject = (v: unknown): v is Record<string, unknown> =>
		typeof v === "object" && v !== null && !Array.isArray(v);
	if (isObject(raw)) return raw;
	if (typeof raw !== "string") return null;
	for (const text of [raw, escapeControlCharsInStrings(raw)]) {
		try {
			const parsed: unknown = JSON.parse(text);
			return isObject(parsed) ? parsed : null;
		} catch {
			// try the next form
		}
	}
	return null;
}

/**
 * Ollama runs the model's PARSER on every chat reply. When the parser SUCCEEDS
 * on native `<tool_call>` markup it strips the call from `content`, and it only
 * puts it in `message.tool_calls` if the request declared that tool: with no
 * `tools` field the call is thrown away and the reply reads as prose ("Let me
 * check the root README."), a silent stall. Proven against qwen3.8:27b-mlx
 * (PARSER qwen3.5, Ollama 0.34.4) on 2026-09-30: the same conversation returned
 * only prose on /v1/chat/completions and /api/chat without `tools`, the full
 * `<tool_call><function=read_file>...` block on raw /api/generate, and a
 * `tool_calls` entry on /v1 once `tools` was declared. So for Ollama the text
 * path declares the registered tools, and reads `message.tool_calls` back.
 * `EIGHT_TEXT_TOOLS_DECLARE=0` turns the declaration off.
 */
export function shouldDeclareTools(
	provider: string,
	tools: ToolSpec[] | undefined,
	env: Record<string, string | undefined> = process.env,
): boolean {
	return provider === "ollama" && (tools?.length ?? 0) > 0 && env.EIGHT_TEXT_TOOLS_DECLARE !== "0";
}

/** Ollama's 400 for a model whose template has no tool support. */
export function isToolsUnsupported(status: number, body: string): boolean {
	return status === 400 && /does not support tools/i.test(body);
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
 * Ollama renderers whose prompt format renderQwenChatML reproduces. Both are
 * Qwen ChatML (`<|im_start|>role ... <|im_end|>`) with a `<think>` block;
 * qwen3.8 also adds a reasoning-effort line to the system turn and renders a
 * (empty) think block on every assistant turn. Source: Ollama 0.34.4
 * model/renderers/qwen35.go (Qwen35Renderer / newQwen38Renderer).
 */
export type QwenChatMLVariant = "qwen3.5" | "qwen3.8";

// What Ollama's qwen3.8 renderer puts in the system turn when the request sets
// no `think` value (our requests never do): its default effort is "xhigh".
const QWEN38_DEFAULT_REASONING =
	"Reasoning effort is set to xhigh. Please think carefully through the task, validate key assumptions, consider plausible alternatives, and prioritize correctness, consistency, and clarity in the final answer.";

/**
 * Render a text-tool conversation as the exact prompt Ollama's qwen3.5 /
 * qwen3.8 renderer builds for it (no native tools, default thinking), ending
 * with the open assistant turn and its `<think>` opener. Used to send the
 * conversation through `/api/generate` with `raw: true`, the one Ollama path
 * that skips the model's built-in output parser. `tool` messages render as
 * `<tool_response>` user turns, as the renderer does. Pure.
 */
export function renderQwenChatML(
	messages: ChatMessage[],
	variant: QwenChatMLVariant,
	noThink = false,
): string {
	// Fold every system message into one leading system turn (qwen3.8 accepts
	// exactly one; our conversations only ever carry one anyway).
	const system = messages
		.filter((m) => m.role === "system")
		.map((m) => m.content.trim())
		.filter((c) => c !== "")
		.join("\n\n");
	const rest = messages.filter((m) => m.role !== "system");

	let out = "";
	const sysParts = variant === "qwen3.8" ? [QWEN38_DEFAULT_REASONING, system] : [system];
	const sysText = sysParts.filter((s) => s !== "").join("\n\n");
	if (sysText !== "") out += `<|im_start|>system\n${sysText}<|im_end|>\n`;

	// qwen3.5 renders a think block only on assistant turns after the last real
	// user query; qwen3.8 renders one on every assistant turn.
	let lastQuery = rest.length - 1;
	for (let i = rest.length - 1; i >= 0; i--) {
		if (rest[i].role === "user") {
			lastQuery = i;
			break;
		}
	}
	for (let i = 0; i < rest.length; i++) {
		const m = rest[i];
		const content = m.content.trim();
		if (m.role === "user") {
			out += `<|im_start|>user\n${content}<|im_end|>\n`;
		} else if (m.role === "assistant") {
			const think = variant === "qwen3.8" || i > lastQuery;
			out += think
				? `<|im_start|>assistant\n<think>\n\n</think>\n\n${content}<|im_end|>\n`
				: `<|im_start|>assistant\n${content}<|im_end|>\n`;
		} else if (m.role === "tool") {
			if (i === 0 || rest[i - 1].role !== "tool") out += "<|im_start|>user";
			out += `\n<tool_response>\n${content}\n</tool_response>`;
			if (i === rest.length - 1 || rest[i + 1].role !== "tool") out += "<|im_end|>\n";
		}
	}
	// Thinking off: pre-close the think block, as the template does for
	// enable_thinking=false, so the completion is the answer itself.
	return noThink
		? `${out}<|im_start|>assistant\n<think>\n\n</think>\n\n`
		: `${out}<|im_start|>assistant\n<think>\n`;
}

/**
 * The visible answer in a raw qwen completion: everything after the closing
 * `</think>` (the prompt opened the think block, so the model's reasoning comes
 * first), minus a trailing `<|im_end|>`. A completion that never closed its
 * think block has no answer yet and yields "". Pure.
 */
export function answerFromRawQwen(raw: string): string {
	const close = raw.lastIndexOf("</think>");
	if (close === -1) return "";
	return raw
		.slice(close + "</think>".length)
		.replace(/<\|im_end\|>\s*$/, "")
		.trim();
}

/** The Ollama server root ("http://h:11434") behind a chat-completions URL. */
export function ollamaRootFromEndpoint(endpoint: string): string {
	return endpoint
		.trim()
		.replace(/\/+$/, "")
		.replace(/\/chat\/completions$/, "")
		.replace(/\/v1$/, "")
		.replace(/\/api\/chat$/, "");
}

/**
 * Which Qwen ChatML renderer (if any) an Ollama model is served with, read
 * from its Modelfile's `RENDERER` line. Returns null for any other model, so
 * the raw path never guesses a prompt format it cannot reproduce. Pure.
 */
export function qwenVariantFromModelfile(modelfile: string): QwenChatMLVariant | null {
	const m = /^RENDERER\s+(\S+)\s*$/m.exec(modelfile);
	if (!m) return null;
	return m[1] === "qwen3.8" || m[1] === "qwen3.5" ? m[1] : null;
}

// Per root+model cache of the renderer lookup (one /api/show per model per
// process, and only ever on the parser-failure path).
const variantCache = new Map<string, Promise<QwenChatMLVariant | null>>();

/** Test hook: forget cached renderer lookups. */
export function _resetQwenVariantCache(): void {
	variantCache.clear();
}

function lookupQwenVariant(
	root: string,
	model: string,
	signal?: AbortSignal,
): Promise<QwenChatMLVariant | null> {
	const key = `${root}\n${model}`;
	const cached = variantCache.get(key);
	if (cached) return cached;
	const pending = (async () => {
		try {
			const res = await modelFetch(
				`${root}/api/show`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ model }),
					signal,
				},
				{ timeoutMs: 15_000, label: `ollama/${model} show` },
			);
			if (!res.ok) return null;
			const data = (await res.json()) as { modelfile?: unknown };
			return typeof data?.modelfile === "string" ? qwenVariantFromModelfile(data.modelfile) : null;
		} catch {
			return null;
		}
	})();
	variantCache.set(key, pending);
	// A failed lookup (null) is not cached forever: a later failure retries it.
	pending.then((v) => {
		if (v === null) variantCache.delete(key);
	});
	return pending;
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
 *
 * The request never inherits Bun's hidden 300 s fetch cap: it goes through
 * modelFetch, whose limit is `timeoutMs` (default: EIGHT_TURN_TIMEOUT_MS via
 * resolveTurnTimeoutMs). A step that runs past it rejects with TurnTimeoutError.
 *
 * When Ollama's built-in tool-call parser eats the reply (a parser 500, see
 * isNativeToolParserFailure, or an empty 200 for generated tokens, see
 * isSwallowedReply), recovery runs in this order, at most one extra request
 * each:
 *  1. Raw re-request (the root-cause fix): if the model is served with a Qwen
 *     ChatML renderer, send the SAME conversation to `/api/generate` with
 *     `raw: true` and the prompt rendered by renderQwenChatML. Raw mode is the
 *     only Ollama path that skips the model's PARSER, so the model's text comes
 *     back untouched and our own parser (which reads native `<tool_call>`
 *     markup too) handles it.
 *  2. Otherwise, or if that fails, ONE /v1 retry with
 *     NATIVE_TOOL_MARKUP_REMINDER appended to a copy of the conversation.
 *  3. If that fails too, reject with an error that names the problem. The call
 *     never resolves to an empty reply after a parser failure.
 *
 * Structured calls: pass `tools` (the registered specs) and, for Ollama, they
 * are declared on the request (see shouldDeclareTools) so a native tool call
 * the model's parser accepted lands in `message.tool_calls` instead of being
 * discarded. Whenever a completion carries `message.tool_calls`, the call
 * resolves to a TextToolReply `{ content, toolCalls }` (content stays the
 * prose reply) instead of a bare string; runTextToolTurn dedupes them
 * against calls written in the text, and a call to an unregistered tool is
 * answered with an error, never run and never dropped (#3091). A model
 * whose template rejects `tools` (Ollama 400 "does not support tools") is sent
 * again without them, and never declared again for this call function.
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
	/**
	 * The registered tool specs. For Ollama they are declared on the request so
	 * the model's parser keeps native tool calls (see shouldDeclareTools).
	 */
	tools?: ToolSpec[];
	/**
	 * Output token budget per model step. Default: resolveMaxOutputTokens(), so
	 * EIGHT_MAX_OUTPUT_TOKENS governs (#3074).
	 */
	maxTokens?: number;
}): (messages: ChatMessage[]) => Promise<string | TextToolReply> {
	const endpoint = opts.endpoint || resolveTextToolEndpoint(opts.provider, opts.baseUrl);
	const temperature = opts.temperature ?? 0.2;
	const maxTokens = opts.maxTokens ?? resolveMaxOutputTokens();
	const label = `${opts.provider}/${opts.model}`;
	const noThink = isOllamaNoThink(opts.provider, opts.model);
	let declareTools = shouldDeclareTools(opts.provider, opts.tools);
	const declared = (opts.tools ?? []).map((t) => ({
		type: "function",
		function: { name: t.name, description: t.description, parameters: t.parameters },
	}));

	const post = (messages: ChatMessage[], withTools: boolean) =>
		modelFetch(
			endpoint,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: opts.model,
					messages,
					temperature,
					max_tokens: maxTokens,
					stream: false,
					...(noThink ? { reasoning_effort: "none" } : {}),
					...(withTools ? { tools: declared } : {}),
				}),
				signal: opts.signal,
			},
			{ timeoutMs: opts.timeoutMs, label },
		);

	type Attempt =
		| { ok: true; content: string; toolCalls: ParsedToolCall[]; completionTokens: number }
		| { ok: false; status: number; body: string };

	// One completion: POST, surface a non-2xx as an error, report real usage,
	// and return the assistant text and structured calls alongside what we need
	// to judge the reply.
	const attempt = async (messages: ChatMessage[]): Promise<Attempt> => {
		let res = await post(messages, declareTools);
		if (!res.ok && declareTools) {
			const body = await res.text().catch(() => "");
			if (!isToolsUnsupported(res.status, body)) return { ok: false, status: res.status, body };
			declareTools = false;
			res = await post(messages, false);
		}
		if (!res.ok) {
			return { ok: false, status: res.status, body: await res.text().catch(() => "") };
		}
		const data = (await res.json()) as {
			choices?: Array<{
				message?: { content?: unknown; tool_calls?: unknown };
				finish_reason?: unknown;
			}>;
			usage?: unknown;
		};
		const usage = extractUsage(data);
		if (usage && opts.onUsage) opts.onUsage(usage);
		// The cap cut the reply off: whatever came back is a fragment, most often
		// a repetition loop. Fail the step loudly rather than hand the loop a
		// truncated reply it would treat as an answer (#3074).
		if (data?.choices?.[0]?.finish_reason === "length") {
			throw new Error(outputCapMessage(label, maxTokens));
		}
		const message = data?.choices?.[0]?.message;
		const content = message?.content;
		return {
			ok: true,
			content: typeof content === "string" ? content : "",
			toolCalls: toolCallsFromMessage(message),
			completionTokens: usage?.completionTokens ?? 0,
		};
	};

	// A completion's result: the bare text, or text plus structured calls.
	const reply = (a: { content: string; toolCalls: ParsedToolCall[] }): string | TextToolReply =>
		a.toolCalls.length > 0 ? { content: a.content, toolCalls: a.toolCalls } : a.content;
	// A reply that carried structured calls was not swallowed, even with no text.
	const swallowed = (a: { content: string; toolCalls: ParsedToolCall[]; completionTokens: number }) =>
		a.toolCalls.length === 0 && isSwallowedReply(opts.provider, a.content, a.completionTokens);

	// The same conversation through Ollama's raw generate path, which never runs
	// the model's built-in parser. Returns the visible answer, or a failure.
	// Raw mode has no `tool_calls`: native markup stays in the text, where our
	// own parser reads it.
	const rawAttempt = async (
		messages: ChatMessage[],
		variant: QwenChatMLVariant,
	): Promise<{ ok: true; content: string } | { ok: false; why: string }> => {
		const root = ollamaRootFromEndpoint(endpoint);
		const res = await modelFetch(
			`${root}/api/generate`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: opts.model,
					prompt: renderQwenChatML(messages, variant, noThink),
					raw: true,
					stream: false,
					options: { temperature, num_predict: maxTokens },
				}),
				signal: opts.signal,
			},
			{ timeoutMs: opts.timeoutMs, label: `${label} (raw)` },
		);
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			return { ok: false, why: `raw generate ${res.status}: ${body.slice(0, 200)}` };
		}
		const data = (await res.json()) as {
			response?: unknown;
			prompt_eval_count?: unknown;
			eval_count?: unknown;
			done_reason?: unknown;
		};
		const p = typeof data?.prompt_eval_count === "number" ? data.prompt_eval_count : null;
		const c = typeof data?.eval_count === "number" ? data.eval_count : null;
		if (p !== null && c !== null && opts.onUsage) {
			opts.onUsage({ promptTokens: p, completionTokens: c, totalTokens: p + c });
		}
		if (data?.done_reason === "length") {
			return { ok: false, why: outputCapMessage(`${label} (raw)`, maxTokens) };
		}
		const rawText = typeof data?.response === "string" ? data.response : "";
		// With thinking off the prompt already closed the think block.
		const content = noThink
			? rawText.replace(/<\|im_end\|>\s*$/, "").trim()
			: answerFromRawQwen(rawText);
		if (content === "") {
			return { ok: false, why: "raw generate returned no answer after the think block" };
		}
		return { ok: true, content };
	};

	return async (messages: ChatMessage[]): Promise<string | TextToolReply> => {
		const first = await attempt(messages);
		let firstFailure: string;
		if (first.ok) {
			if (!swallowed(first)) return reply(first);
			firstFailure = `an empty reply for ${first.completionTokens} generated tokens`;
		} else if (isNativeToolParserFailure(opts.provider, first.status, first.body)) {
			firstFailure = `${first.status} ${first.body.slice(0, 200)}`;
		} else {
			throw new Error(
				`${opts.provider} chat completions ${first.status}: ${first.body.slice(0, 300)}`,
			);
		}

		// 1. Root-cause recovery: bypass the parser with a raw request.
		let rawNote = "the model's prompt format is not one the raw path can render";
		const variant = await lookupQwenVariant(
			ollamaRootFromEndpoint(endpoint),
			opts.model,
			opts.signal,
		);
		if (variant) {
			const raw = await rawAttempt(messages, variant).catch(
				(e: unknown) => ({ ok: false as const, why: e instanceof Error ? e.message : String(e) }),
			);
			if (raw.ok) return raw.content;
			rawNote = raw.why;
		}

		// 2. One reminder retry on the normal endpoint.
		const retry = await attempt([
			...messages,
			{ role: "user", content: NATIVE_TOOL_MARKUP_REMINDER },
		]);
		if (retry.ok && !swallowed(retry)) return reply(retry);

		// 3. Out of recoveries: say what happened, never hand back "".
		const retryFailure = retry.ok
			? `an empty reply for ${retry.completionTokens} generated tokens`
			: `${retry.status} ${retry.body.slice(0, 200)}`;
		throw new Error(
			`${opts.provider} chat completions: the model replied in native tool-call markup that ` +
				`${opts.provider}'s built-in tool-call parser rejected (${firstFailure}). ` +
				`Raw re-request without the parser: ${variant ? "failed" : "skipped"} (${rawNote}). ` +
				`Retried once with a format reminder and it failed again (${retryFailure}).`,
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
