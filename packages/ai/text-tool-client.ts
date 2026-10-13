/**
 * 8gent AI - One-Round Text-Tool Adapter
 *
 * Wires the pure text tool-call protocol (see ./text-tools) to an injected
 * model call. Given a conversation and a tool set, it injects the tool
 * instructions into the system prompt, runs ONE model turn through the caller's
 * `call` function, then parses the reply into prose plus any tool calls.
 *
 * This module performs no network or I/O of its own: the actual model
 * invocation is supplied by the caller via `opts.call`. It never mutates the
 * caller's messages array or message objects.
 */

import {
	buildToolSystemPrompt,
	findUnterminatedToolCall,
	parseToolCalls,
	stripToolCalls,
	type ParsedToolCall,
	type ToolSpec,
} from "./text-tools";

export type TextToolMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	/**
	 * Images the model should see with this message, as data URLs (#3641). Set
	 * only when the model is vision-capable; the endpoint sends them in the
	 * provider's native image field and `content` stays the plain text.
	 */
	images?: string[];
};

export type TextToolTurn = {
	content: string;
	toolCalls: ParsedToolCall[];
	/**
	 * Set when the reply ended inside a `tool_call` block whose JSON never
	 * closed (normally the output token limit). That call did not run; the
	 * partial block is excluded from `content`. `name` is null when the tool
	 * name itself was cut off.
	 */
	cutOffToolCall?: { name: string | null };
};

/**
 * What a `call` may resolve to besides a bare string: the reply text plus the
 * calls the endpoint returned as structured `message.tool_calls` (Ollama moves
 * a native tool call there once its parser accepts it, and strips it from the
 * text). runTextToolTurn keeps them all; a call to a tool that is not
 * registered never runs and is answered with an error (#3091).
 */
export type TextToolReply = {
	content: string;
	toolCalls: ParsedToolCall[];
};

export type TextToolCall = (messages: TextToolMessage[]) => Promise<string | TextToolReply>;

export interface TextToolTurnOptions {
	messages: TextToolMessage[];
	tools: ToolSpec[];
	call: TextToolCall;
}

/** Canonical JSON (object keys sorted) so equal arguments compare equal. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const obj = value as Record<string, unknown>;
		return `{${Object.keys(obj)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * The calls from the reply text, then each structured call that the text did
 * not already carry (same name and same arguments, compared as canonical
 * JSON). A structured call to an unregistered name is KEPT: the endpoint's
 * parser returned it, so it is the model's call, not an example in prose. The
 * loop never runs it (no such tool) and answers it with an error naming the
 * tools that exist. Dropping it made the call vanish and the model was told it
 * had called nothing (#3091). Pure.
 */
export function mergeToolCalls(
	fromText: ParsedToolCall[],
	structured: ParsedToolCall[],
): ParsedToolCall[] {
	const seen = new Set(fromText.map((c) => `${c.name}\u0000${canonical(c.arguments)}`));
	const merged = fromText.slice();
	for (const call of structured) {
		const key = `${call.name}\u0000${canonical(call.arguments)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(call);
	}
	return merged;
}

/**
 * Build a new messages array with the tool instructions injected into the
 * system prompt. Never mutates the input array or its message objects.
 *
 * - First message is "system": prepend instructions, a blank line, then the
 *   existing system content (as a fresh object).
 * - Otherwise: insert a new leading system message holding the instructions.
 * - When `tools` is empty: pass the messages through as a shallow copy with no
 *   added system content.
 *
 * Only the FIRST message is inspected, so a later system message is passed
 * through as-is (never merged). An empty messages array with tools present
 * yields a single synthesized leading system message holding the instructions.
 */
function withToolInstructions(
	messages: TextToolMessage[],
	tools: ToolSpec[],
): TextToolMessage[] {
	if (tools.length === 0) {
		// No instructions to add. Return a shallow copy so we never hand back the
		// caller's own array, while leaving every message object untouched.
		return messages.slice();
	}

	const instructions = buildToolSystemPrompt(tools);
	const first = messages[0];

	if (first && first.role === "system") {
		const merged: TextToolMessage = {
			role: "system",
			content: `${instructions}\n\n${first.content}`,
		};
		return [merged, ...messages.slice(1)];
	}

	const systemMessage: TextToolMessage = {
		role: "system",
		content: instructions,
	};
	return [systemMessage, ...messages];
}

/**
 * Run one text-tool model turn.
 *
 * Injects the tool instructions into the system prompt, calls the injected
 * model `call` once, then returns the stripped prose and any parsed tool calls
 * (those written in the text first, then any structured ones the call
 * returned, deduped; see mergeToolCalls).
 * Never throws for normal model output. If `call` itself rejects, the rejection
 * propagates unchanged.
 */
export async function runTextToolTurn(
	opts: TextToolTurnOptions,
): Promise<TextToolTurn> {
	const messages = withToolInstructions(opts.messages, opts.tools);
	const reply = await opts.call(messages);
	const raw = typeof reply === "string" ? reply : reply.content;
	const structured = typeof reply === "string" ? [] : reply.toolCalls;
	// Only registered tools may be called in the bare / ```json JSON form, so a
	// JSON example in an answer never runs.
	const parse = { knownTools: opts.tools.map((t) => t.name) };
	const calls = (text: string) => mergeToolCalls(parseToolCalls(text, parse), structured);
	const cutOff = findUnterminatedToolCall(raw);
	if (cutOff) {
		// Everything before the cut-off block is still usable; the partial
		// block itself is neither a call nor prose.
		const head = raw.slice(0, cutOff.fenceStart);
		return {
			content: stripToolCalls(head, parse),
			toolCalls: calls(head),
			cutOffToolCall: { name: cutOff.name },
		};
	}
	return {
		content: stripToolCalls(raw, parse),
		toolCalls: calls(raw),
	};
}
