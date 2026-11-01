/**
 * Final-output sanitizer for the meta-harness (#2804).
 *
 * The local text-tool protocol can leak: a model sometimes emits a `tool_call`
 * block in a shape the loop's parser does not recognize (for example the fence
 * marker on its own line with `tool_call` as the first body line). The block is
 * then never executed and the raw protocol syntax would surface verbatim as the
 * final answer. A `done` StatusEvent must mean "the agent produced its intended
 * answer", so LocalHarness runs the final chat output through this sanitizer:
 *
 *  - canonical ```tool_call fenced blocks are stripped with the same
 *    balanced-object scanner the loop itself uses (packages/ai/text-tools);
 *  - the leaked variants (bare fence + `tool_call` body line, or an unfenced
 *    `tool_call` line followed by the JSON object) are detected and stripped
 *    here, requiring the literal `tool_call` marker plus a JSON object with a
 *    string `name` so ordinary code blocks and JSON answers are never touched;
 *  - the caller turns a protocol-only answer (nothing left after stripping)
 *    into an `error` StatusEvent instead of a `done`.
 */

import { stripToolCalls } from "../ai/text-tools";

export interface SanitizedOutput {
	/** The answer with unexecuted tool_call protocol removed, trimmed. */
	text: string;
	/** True when at least one tool_call protocol block was stripped. */
	strippedToolCall: boolean;
}

/** True when `body` parses as a JSON object with a string `name` (a tool call). */
function isToolCallJson(body: string): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return false;
	}
	return (
		typeof parsed === "object" &&
		parsed !== null &&
		!Array.isArray(parsed) &&
		typeof (parsed as Record<string, unknown>).name === "string"
	);
}

// A fenced code block: ```info-line, body, closing ```.
const FENCED_BLOCK = /```[^\n]*\r?\n([\s\S]*?)```/g;

/**
 * Strip fenced blocks whose body starts with a `tool_call` marker line followed
 * by a tool-call JSON object - the leaked variant the canonical parser misses
 * because the marker is not on the fence line itself.
 */
function stripLeakedFencedBlocks(text: string): { text: string; stripped: boolean } {
	let stripped = false;
	const out = text.replace(FENCED_BLOCK, (match, body: string) => {
		const inner = body.trim();
		const markerMatch = /^tool_call\s*\r?\n([\s\S]*)$/.exec(inner);
		if (markerMatch && isToolCallJson(markerMatch[1].trim())) {
			stripped = true;
			return "";
		}
		return match;
	});
	return { text: out, stripped };
}

/**
 * Sanitize the final chat output before it becomes a StatusEvent `output`.
 * Never throws. Never rewrites prose - only removes unexecuted tool_call
 * protocol blocks (canonical fence, leaked fence, or a bare whole-answer
 * `tool_call` line + JSON object).
 */
export function sanitizeFinalOutput(raw: string): SanitizedOutput {
	if (!raw) return { text: "", strippedToolCall: false };

	let strippedToolCall = false;

	// 1. Canonical ```tool_call blocks via the loop's own balanced-object scanner.
	const canonical = stripToolCalls(raw);
	if (canonical !== raw.trim()) strippedToolCall = true;

	// 2. Leaked fenced variant: marker on the first body line instead of the fence.
	const fencePass = stripLeakedFencedBlocks(canonical);
	if (fencePass.stripped) strippedToolCall = true;
	let text = fencePass.text.trim();

	// 3. Bare whole-answer variant: `tool_call` line then the JSON object, no fence.
	const bare = /^tool_call\s*\r?\n([\s\S]*)$/.exec(text);
	if (bare && isToolCallJson(bare[1].trim())) {
		strippedToolCall = true;
		text = "";
	}

	return { text, strippedToolCall };
}
