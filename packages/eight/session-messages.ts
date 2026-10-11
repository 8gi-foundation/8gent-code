/**
 * The one definition of "the chat a person sees": user and assistant turns
 * with text, minus the harness's own user-role notes. Every whole-list save
 * (TUI autosave, /share, daemon turns) goes through this, so the same
 * conversation always has the same shape and saves never branch on noise.
 */

import { CONTEXT_NOTE_HEADER } from "./context-note";
import { PLANNING_GATE_INSTRUCTION } from "./prompt";

export interface ChatMessage {
	role: string;
	content: string;
}

/** The planning gate is injected after the user's words; any depth's variant starts the same. */
const PLANNING_GATE_PREFIX = PLANNING_GATE_INSTRUCTION.slice(0, 60);

/**
 * True for the harness's own user-role notes: session context, vision and
 * clarification notes (CONTEXT_NOTE_HEADER) and the planning gate. They sit in
 * the agent's history as role "user" but no person typed them.
 */
export function isHarnessNote(content: string): boolean {
	return content.startsWith(CONTEXT_NOTE_HEADER) || content.startsWith(PLANNING_GATE_PREFIX);
}

/** User and assistant turns with text content that a person wrote or reads. */
export function chatMessages(history: Array<{ role: string; content: unknown }>): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const m of history) {
		if (
			(m.role === "user" || m.role === "assistant") &&
			typeof m.content === "string" &&
			m.content &&
			!(m.role === "user" && isHarnessNote(m.content))
		) {
			out.push({ role: m.role, content: m.content });
		}
	}
	return out;
}
