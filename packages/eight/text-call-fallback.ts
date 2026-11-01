/**
 * A native turn whose model wrote its tool call as text (#4807).
 *
 * llama-server serving a Qwen-family model returns the call in `content`
 * (`<tool_call>{"name": ..., "arguments": {...}}</tool_call>`) with no
 * `tool_calls` when the served chat template does not carry the tools, so the
 * AI SDK loop sees a plain reply: the raw markup is shown and the tool never
 * runs. The harness-side text protocol already parses exactly this shape, so
 * the turn is handed to it. Only when no tool has run yet this turn (a re-run
 * after a tool call would repeat its side effects) and only for a registered
 * tool name, and only when the reply is the call and at most a short lead-in:
 * no code fence anywhere (an example in a ```json or ```tool_call fence is an
 * answer, not a call) and under LEAD_IN_MAX chars of prose around it.
 */
import { parseToolCalls, stripToolCalls } from "../ai/text-tools";

/** What may surround the call: a short lead-in such as "Let me check.", never an answer. */
const LEAD_IN_MAX = 120;

export function replyIsTextToolCall(
	text: string | undefined,
	toolsRunThisTurn: number,
	knownTools: Iterable<string>,
): boolean {
	if (toolsRunThisTurn > 0 || !text?.trim()) return false;
	if (text.includes("```")) return false;
	// Other ways to show code: ~~~ fences, <pre>/<code>, and indented blocks.
	if (/^[ \t]*~~~/m.test(text)) return false;
	if (/<\/?(pre|code)\b/i.test(text)) return false;
	if (/^(?: {4,}|\t)[ \t]*(\{|<tool_call>)/m.test(text)) return false;
	const known = [...knownTools];
	if (parseToolCalls(text, { knownTools: known }).length === 0) return false;
	return stripToolCalls(text, { knownTools: known }).length < LEAD_IN_MAX;
}
