/**
 * OpenAI wire-format mapping.
 *
 * Translates between the OpenAI Chat Completions request/response shape and the
 * 8gent router's `ChatRequest` / `ChatResponse` (`packages/providers`). We do
 * NOT reimplement any routing here - this file is pure shape translation. All
 * provider selection, the PII-egress gate, thinking-level resolution and
 * dispatch stay inside `ProviderManager.chat()`.
 */

import type {
	ChatMessage,
	ChatRequest,
	ChatResponse,
	ToolCall,
	ToolDefinition,
} from "../../../packages/providers";
import type { ThinkingLevel } from "../../../packages/types";

/** Minimal shape of an incoming OpenAI Chat Completions request. */
export interface OpenAIChatRequest {
	model?: string;
	messages?: Array<{
		role: string;
		content?: unknown;
		tool_call_id?: string;
		tool_calls?: Array<{
			id?: string;
			type?: string;
			function?: { name?: string; arguments?: unknown };
		}>;
	}>;
	tools?: unknown;
	temperature?: number;
	max_tokens?: number;
	stream?: boolean;
	reasoning_effort?: string;
}

const VALID_ROLES = new Set(["system", "user", "assistant", "tool"]);
const VALID_THINKING = new Set(["low", "medium", "high"]);

/**
 * OpenAI allows `content` to be a string or an array of typed parts. Flatten to
 * a single string; only text parts survive (this proxy front-ends text/tool
 * chat, not vision - vision requests still route, they just lose non-text
 * parts on the way in).
 */
function flattenContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object" && "text" in part) {
					return String((part as { text: unknown }).text ?? "");
				}
				return "";
			})
			.join("");
	}
	if (content == null) return "";
	return String(content);
}

/** Map OpenAI messages to the router's `ChatMessage[]`. Unknown roles become `user`. */
export function toChatMessages(
	messages: OpenAIChatRequest["messages"],
): ChatMessage[] {
	if (!Array.isArray(messages)) return [];
	return messages.map((m) => {
		const role = VALID_ROLES.has(m.role)
			? (m.role as ChatMessage["role"])
			: "user";
		const msg: ChatMessage = { role, content: flattenContent(m.content) };
		if (m.tool_call_id) msg.toolCallId = m.tool_call_id;
		const toolCalls = toRouterToolCalls(m.tool_calls);
		if (toolCalls) msg.toolCalls = toolCalls;
		return msg;
	});
}

/**
 * Carry an assistant turn's OpenAI `tool_calls` into the router (#3547), so the
 * next step upstream still sees the calls its tool replies answer. Arguments
 * arrive as a JSON string; anything unparseable becomes `{}` rather than
 * failing the whole request.
 */
function toRouterToolCalls(
	calls: NonNullable<OpenAIChatRequest["messages"]>[number]["tool_calls"],
): ToolCall[] | undefined {
	if (!Array.isArray(calls) || calls.length === 0) return undefined;
	const out: ToolCall[] = [];
	for (const c of calls) {
		const name = c?.function?.name;
		if (typeof name !== "string") continue;
		out.push({ id: typeof c.id === "string" ? c.id : "", name, arguments: parseArgs(c.function?.arguments) });
	}
	return out.length > 0 ? out : undefined;
}

function parseArgs(raw: unknown): Record<string, unknown> {
	let v = raw;
	if (typeof raw === "string") {
		try {
			v = JSON.parse(raw);
		} catch {
			return {};
		}
	}
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * OpenAI tool definitions already match the router's `ToolDefinition` shape
 * (`{ type: "function", function: { name, description, parameters } }`), so we
 * only validate and pass through.
 */
export function toToolDefinitions(tools: unknown): ToolDefinition[] | undefined {
	if (!Array.isArray(tools) || tools.length === 0) return undefined;
	const out: ToolDefinition[] = [];
	for (const t of tools) {
		const fn = (t as { function?: { name?: unknown; description?: unknown; parameters?: unknown } })
			?.function;
		if (!fn || typeof fn.name !== "string") continue;
		out.push({
			type: "function",
			function: {
				name: fn.name,
				description: typeof fn.description === "string" ? fn.description : "",
				parameters:
					fn.parameters && typeof fn.parameters === "object"
						? (fn.parameters as Record<string, unknown>)
						: {},
			},
		});
	}
	return out.length > 0 ? out : undefined;
}

/** Build the router `ChatRequest` from an OpenAI request body. */
export function toChatRequest(body: OpenAIChatRequest): ChatRequest {
	const req: ChatRequest = {
		messages: toChatMessages(body.messages),
	};
	if (typeof body.model === "string" && body.model.length > 0) req.model = body.model;
	const tools = toToolDefinitions(body.tools);
	if (tools) req.tools = tools;
	if (typeof body.temperature === "number") req.temperature = body.temperature;
	if (typeof body.max_tokens === "number") req.maxTokens = body.max_tokens;
	if (typeof body.reasoning_effort === "string" && VALID_THINKING.has(body.reasoning_effort)) {
		req.thinking = body.reasoning_effort as ThinkingLevel;
	}
	return req;
}

function newId(): string {
	return `chatcmpl-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function toOpenAIToolCalls(res: ChatResponse) {
	if (!res.toolCalls || res.toolCalls.length === 0) return undefined;
	return res.toolCalls.map((tc) => ({
		id: tc.id,
		type: "function" as const,
		function: {
			name: tc.name,
			arguments: JSON.stringify(tc.arguments ?? {}),
		},
	}));
}

function toOpenAIUsage(res: ChatResponse) {
	if (!res.usage) return undefined;
	return {
		prompt_tokens: res.usage.promptTokens,
		completion_tokens: res.usage.completionTokens,
		total_tokens: res.usage.totalTokens,
	};
}

/** Map a router `ChatResponse` to a non-streaming OpenAI completion object. */
export function toOpenAICompletion(res: ChatResponse) {
	const toolCalls = toOpenAIToolCalls(res);
	return {
		id: newId(),
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: res.model,
		// Surface the provider the router actually dispatched to. Not part of the
		// OpenAI spec, but harmless to clients and honest about routing.
		provider: res.provider,
		choices: [
			{
				index: 0,
				message: {
					role: "assistant" as const,
					content: res.content,
					...(toolCalls ? { tool_calls: toolCalls } : {}),
				},
				finish_reason: toolCalls ? ("tool_calls" as const) : ("stop" as const),
			},
		],
		...(toOpenAIUsage(res) ? { usage: toOpenAIUsage(res) } : {}),
	};
}

/**
 * Serialize a router `ChatResponse` as a Server-Sent-Events stream.
 *
 * The router is non-streaming (`ProviderManager.chat()` resolves the whole
 * completion at once), so we emit a role frame, a single content-delta frame,
 * an optional tool-calls frame, then a terminal frame - rather than pretending
 * to stream tokens we do not have. Clients that require SSE still work.
 */
export function toOpenAISSE(res: ChatResponse): string {
	const id = newId();
	const created = Math.floor(Date.now() / 1000);
	const base = { id, object: "chat.completion.chunk", created, model: res.model };
	const frames: string[] = [];
	const emit = (choice: Record<string, unknown>) => {
		frames.push(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
	};

	emit({ index: 0, delta: { role: "assistant" }, finish_reason: null });
	if (res.content) {
		emit({ index: 0, delta: { content: res.content }, finish_reason: null });
	}
	const toolCalls = toOpenAIToolCalls(res);
	if (toolCalls) {
		emit({
			index: 0,
			delta: {
				tool_calls: toolCalls.map((tc, i) => ({ index: i, ...tc })),
			},
			finish_reason: null,
		});
	}
	emit({
		index: 0,
		delta: {},
		finish_reason: toolCalls ? "tool_calls" : "stop",
	});
	frames.push("data: [DONE]\n\n");
	return frames.join("");
}
