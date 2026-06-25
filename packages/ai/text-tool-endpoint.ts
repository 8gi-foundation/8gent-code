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
};

/** Resolve a provider's text-tool endpoint, defaulting to LM Studio's. */
export function resolveTextToolEndpoint(provider: string): string {
	return TEXT_TOOL_ENDPOINTS[provider] || TEXT_TOOL_ENDPOINTS.lmstudio;
}

type ChatMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
};

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
	temperature?: number;
	signal?: AbortSignal;
}): (messages: ChatMessage[]) => Promise<string> {
	const endpoint = opts.endpoint || resolveTextToolEndpoint(opts.provider);
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
		};
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
