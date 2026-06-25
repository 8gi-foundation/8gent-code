/**
 * 8gent AI - Text-Protocol Tool Calling
 *
 * Lets local models that lack native tool-calling be driven agentically.
 * Instead of a structured tool-call API, the model is instructed (via a system
 * prompt) to emit tool calls as fenced markdown code blocks tagged `tool_call`,
 * each containing one JSON object of the form {"name": "...", "arguments": {...}}.
 *
 * This module is pure: it renders the instruction prompt, parses tool-call
 * blocks back out of a model reply, and strips them to recover the prose. No
 * I/O, no network.
 */

export type ToolSpec = {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
};

export type ParsedToolCall = {
	name: string;
	arguments: Record<string, unknown>;
};

// Matches a fenced block opened by ```tool_call and closed by ``` on its own
// line. The body (group 1) is captured lazily so consecutive blocks are kept
// separate. Flags: g (all blocks), m (^/$ per line), s (. spans newlines in
// the body). The closing fence must sit at the start of a line.
const TOOL_CALL_BLOCK = /```tool_call[ \t]*\r?\n(.*?)\r?\n?```/gs;

/**
 * Render the instruction block that teaches a model the text tool-call
 * protocol. The returned string lists every tool (name, description, parameter
 * schema) and defines the fenced-block call syntax. It always contains the
 * literal token `tool_call` and each tool name verbatim.
 */
export function buildToolSystemPrompt(tools: ToolSpec[]): string {
	const toolBlocks = tools
		.map((t) => {
			const schema = JSON.stringify(t.parameters, null, 2);
			return [
				`### ${t.name}`,
				t.description,
				"",
				"Parameters (JSON schema):",
				"```json",
				schema,
				"```",
			].join("\n");
		})
		.join("\n\n");

	const toolsSection =
		tools.length > 0 ? toolBlocks : "(No tools are available right now.)";

	return [
		"You can call tools to gather information or take actions.",
		"",
		"To call a tool, emit a fenced code block tagged `tool_call` containing",
		"exactly one JSON object of this form:",
		"",
		"```tool_call",
		'{"name": "tool_name", "arguments": {"arg": "value"}}',
		"```",
		"",
		"Rules:",
		"- One JSON object per `tool_call` block. The object MUST have a string",
		'  "name" and an "arguments" object (use {} when the tool takes no args).',
		"- You may emit several `tool_call` blocks in a single reply to call",
		"  several tools at once.",
		"- Any normal prose you write OUTSIDE `tool_call` blocks is treated as your",
		"  final answer to the user. Do not wrap your final answer in a block.",
		"- After a tool runs, its result is sent back to you and you may call more",
		"  tools or give your final answer.",
		"",
		"Available tools:",
		"",
		toolsSection,
	].join("\n");
}

/**
 * Extract every well-formed `tool_call` block from a model reply.
 *
 * Tolerates arbitrary prose before, between, and after blocks. A block is
 * skipped (never throws) when its body is not valid JSON, is not an object, or
 * lacks a string `name`. `arguments` is preserved as-is when it is an object,
 * and defaults to {} when absent. Returns [] when there are no valid calls.
 */
export function parseToolCalls(text: string): ParsedToolCall[] {
	const calls: ParsedToolCall[] = [];
	if (!text) return calls;

	for (const match of text.matchAll(TOOL_CALL_BLOCK)) {
		const body = match[1];
		if (body === undefined) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(body.trim());
		} catch {
			continue;
		}

		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			continue;
		}

		const obj = parsed as Record<string, unknown>;
		if (typeof obj.name !== "string") continue;

		const rawArgs = obj.arguments;
		const args =
			typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
				? (rawArgs as Record<string, unknown>)
				: {};

		calls.push({ name: obj.name, arguments: args });
	}

	return calls;
}

/**
 * Remove every `tool_call` block from the text and return the remaining
 * natural-language portion, trimmed.
 */
export function stripToolCalls(text: string): string {
	return text.replace(TOOL_CALL_BLOCK, "").trim();
}
