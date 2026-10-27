/**
 * Reasoning blocks never leave the machine. A model that thinks out loud wraps it in
 * <think>...</think> (also <thinking>, <reasoning>). Every outbound channel message goes
 * through this first, so a chat only ever sees the answer. The stripped text is dropped:
 * it is never logged and never posted anywhere.
 */
const TAGS = "think|thinking|reasoning";
const CLOSED = new RegExp(`<(${TAGS})(?:\\s[^>]*)?>[\\s\\S]*?</\\1\\s*>`, "gi");
const UNCLOSED = new RegExp(`<(?:${TAGS})(?:\\s[^>]*)?>[\\s\\S]*$`, "i");
const ORPHAN_CLOSE = new RegExp(`^[\\s\\S]*</(?:${TAGS})\\s*>`, "i");

export function stripReasoning(text: string): string {
	if (!text || !/<\/?(?:think|thinking|reasoning)/i.test(text)) return text;
	let out = text.replace(CLOSED, "");
	// A stray close with no open: everything before it was reasoning.
	if (!new RegExp(`<(?:${TAGS})(?:\\s[^>]*)?>`, "i").test(out)) out = out.replace(ORPHAN_CLOSE, "");
	// An unclosed block (cut-off stream): everything from its tag to the end is reasoning.
	out = out.replace(UNCLOSED, "");
	return out.replace(/^\s+/, "");
}
