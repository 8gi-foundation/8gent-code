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

// Locates the opening fence of a tool-call block: ```tool_call followed by the
// rest of that line. Flags: g so we can iterate every block. We deliberately do
// NOT try to match the block body or closing fence with a regex - the body is a
// JSON object that can itself contain ``` and braces inside string values, so
// the body is bounded by a balanced-brace scan (scanBalancedObject) starting at
// the first `{` after this fence, not by the trailing fence.
const TOOL_CALL_OPEN = /```tool_call[^\n]*\r?\n?/g;

/**
 * Starting at `start` in `text`, find the first `{` and return the index range
 * [openBrace, endExclusive) of the balanced JSON object it begins, where
 * endExclusive is one past the matching `}` at depth 0. Tracks string state so
 * braces and fences inside JSON string values are ignored, and respects `\`
 * escapes inside strings. Returns null if no `{` is found or the object never
 * closes.
 */
function scanBalancedObject(
	text: string,
	start: number,
): { open: number; end: number } | null {
	let i = start;
	while (i < text.length && text[i] !== "{") i++;
	if (i >= text.length) return null;

	const open = i;
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === "{") {
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0) return { open, end: i + 1 };
		}
	}
	return null;
}

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
		"IMPORTANT - tool-call format. This system does NOT support any built-in or",
		"native tool-calling channel. The ONLY way to call a tool is to write a",
		"three-backtick fenced code block whose info string is exactly the word",
		"tool_call, with one JSON object inside it. Copy this shape EXACTLY:",
		"",
		"```tool_call",
		'{"name": "tool_name", "arguments": {"arg": "value"}}',
		"```",
		"",
		"The opening fence MUST be three backticks immediately followed by the literal",
		"word tool_call on its own line, then the JSON object on the next line(s), then",
		"a closing line of three backticks. Do NOT invent any other syntax. In",
		"particular do NOT use angle brackets, pipes, XML-style tags, <tool_call>,",
		"<|tool_call|>, call:, or function-call markup of any kind. ONLY the fenced",
		"```tool_call block shown above is recognized; anything else is ignored and the",
		"tool will NOT run.",
		"",
		"Worked example. If asked to read /tmp/x.txt, your ENTIRE reply must be:",
		"",
		"```tool_call",
		'{"name": "read_file", "arguments": {"path": "/tmp/x.txt"}}',
		"```",
		"",
		"Rules:",
		"- One JSON object per `tool_call` block. The object MUST have a string",
		'  "name" and an "arguments" object (use {} when the tool takes no args).',
		"- When you need a tool, reply with ONLY the tool_call block(s) and no other",
		"  prose. Do not explain that you are about to call a tool; just call it.",
		"- You may emit several `tool_call` blocks in a single reply to call",
		"  several tools at once.",
		"- Any normal prose you write OUTSIDE `tool_call` blocks is treated as your",
		"  final answer to the user. Do not wrap your final answer in a block.",
		"- After a tool runs, its result is sent back to you and you may call more",
		"  tools or give your final answer as plain prose.",
		"- NEVER guess, invent, or recall a tool's output from memory. If a step needs",
		"  a file's contents, a directory listing, a command's output, or any fact you",
		"  do not already have from a prior tool result in THIS conversation, you MUST",
		"  call the matching tool to get it. Do not fabricate file names, paths, or",
		"  results.",
		"- If a request has multiple parts (for example: read a file AND list a",
		"  directory), handle them one at a time: call the tool for the first part,",
		"  wait for its result, then call the tool for the next part. Only give your",
		"  final prose answer once every part is backed by a real tool result.",
		"",
		"Available tools:",
		"",
		toolsSection,
	].join("\n");
}

// One tool-call block located in the source text: where its opening fence
// starts, where the block ends (one past the JSON object, plus an optional
// trailing ``` fence line), and the parsed call (null if the block was not a
// valid call and should be skipped by parsers but still stripped from prose).
type LocatedBlock = {
	fenceStart: number;
	end: number;
	call: ParsedToolCall | null;
};

// If an optional closing ``` fence immediately follows the JSON object (only
// whitespace between), consume through the end of that fence line so
// stripToolCalls leaves no shrapnel. Returns the index to cut up to.
function consumeTrailingFence(text: string, afterObject: number): number {
	const rest = text.slice(afterObject);
	// Optional whitespace/newline, then ``` , then the rest of that line.
	const m = /^[ \t]*\r?\n?```[^\n]*(\r?\n)?/.exec(rest);
	return m ? afterObject + m[0].length : afterObject;
}

/**
 * Locate every tool-call block in `text`. The block body is bounded by a
 * balanced JSON object (so ``` and braces inside JSON string values are safe),
 * not by the trailing fence. Never throws.
 */
function locateBlocks(text: string): LocatedBlock[] {
	const blocks: LocatedBlock[] = [];
	if (!text) return blocks;

	const opener = new RegExp(TOOL_CALL_OPEN.source, "g");
	let match: RegExpExecArray | null;
	let searchFrom = 0;

	while ((match = opener.exec(text)) !== null) {
		const fenceStart = match.index;
		// Skip openers that fall inside an already-consumed block.
		if (fenceStart < searchFrom) continue;

		const obj = scanBalancedObject(text, opener.lastIndex);
		if (!obj) {
			// No JSON object after this fence; advance past the fence and continue.
			searchFrom = opener.lastIndex;
			continue;
		}

		const end = consumeTrailingFence(text, obj.end);
		blocks.push({ fenceStart, end, call: parseCall(text.slice(obj.open, obj.end)) });

		// Continue scanning after this block.
		searchFrom = end;
		opener.lastIndex = end;
	}

	return blocks;
}

// Parse one JSON object substring into a ParsedToolCall, or null if it is not a
// valid object with a string `name`. Never throws.
function parseCall(jsonText: string): ParsedToolCall | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return null;
	}
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.name !== "string") return null;

	const rawArgs = obj.arguments;
	const args =
		typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
			? (rawArgs as Record<string, unknown>)
			: {};

	return { name: obj.name, arguments: args };
}

/**
 * Extract every well-formed `tool_call` block from a model reply.
 *
 * Tolerates arbitrary prose before, between, and after blocks. The block body
 * is the balanced JSON object after the opening fence, so a ``` or brace inside
 * a JSON string value (for example file content) is parsed correctly. A block
 * is skipped (never throws) when no balanced object parses, it is not an object,
 * or it lacks a string `name`. `arguments` is preserved as-is when it is an
 * object, and defaults to {} when absent. Returns [] when there are none.
 */
export function parseToolCalls(text: string): ParsedToolCall[] {
	const calls: ParsedToolCall[] = [];
	for (const block of locateBlocks(text)) {
		if (block.call) calls.push(block.call);
	}
	return calls;
}

/**
 * Decide whether the harness should drive tools through the text protocol
 * (buildToolSystemPrompt + runTextToolTurn) instead of native OpenAI-style
 * tool calling.
 *
 * A provider/model whose served chat template rejects a `tools` payload (some
 * local LM Studio GGUF templates 400 on it) cannot use native tool calling. For
 * those, the harness keeps tool orchestration in itself: it omits the native
 * `tools` field, injects the tool instructions into the system prompt, and
 * parses the model's plain-text reply for `tool_call` blocks. This gate is the
 * single decision point for that switch.
 *
 * Pure: returns the negation of native-tool support.
 */
export function needsTextTools(opts: { supportsNativeTools: boolean }): boolean {
	return !opts.supportsNativeTools;
}

/**
 * Remove every `tool_call` block (opening fence through the JSON object and an
 * optional trailing fence) and return the remaining natural-language portion,
 * trimmed. Blocks are removed even when their JSON did not parse, so no JSON
 * shrapnel is left in the prose.
 */
export function stripToolCalls(text: string): string {
	if (!text) return "";
	const blocks = locateBlocks(text);
	if (blocks.length === 0) return text.trim();

	let out = "";
	let cursor = 0;
	for (const block of blocks) {
		out += text.slice(cursor, block.fenceStart);
		cursor = block.end;
	}
	out += text.slice(cursor);
	return out.trim();
}
