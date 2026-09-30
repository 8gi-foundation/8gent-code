/**
 * Session context that changes, kept out of the system prompt (#3222).
 *
 * A local server reuses its KV cache only for the byte-identical prefix of a
 * request. Anything that differs per session (saved memories, prior sessions)
 * or per turn (self-appended context, voice mode) therefore travels as a
 * message appended to the history at the point it changes, never as an edit to
 * the system prompt. The history stays append-only, so every earlier turn
 * remains a cached prefix.
 *
 * Pure: the caller keeps the record of what it last sent.
 */

export const CONTEXT_NOTE_HEADER = "[Session context from the harness, not typed by the user]";

const VOICE_ON = `## Voice Chat Mode (active)
You are in a real-time voice conversation. The user is speaking to you; their words arrive as transcribed text (STT). Your written replies are spoken back to them via text-to-speech (TTS). You are NOT a text-only interface: you can hear them and they can hear you. Speak conversationally as if on a phone call. Do not apologise for being text-only or claim you cannot hear them. You can. Keep replies concise and natural since they will be spoken aloud. Avoid heavy markdown, code blocks, or long URLs; they don't read well in TTS.`;

const VOICE_OFF = `## Voice Chat Mode (off)
Voice chat has ended. Replies are read as text again.`;

const APPENDED_HEADING = "## Agent Self-Appended Context";

export interface ContextState {
	/** Saved memories and prior-session recall, fixed when the agent is built. */
	memory: string;
	appendedContext: readonly string[];
	voiceChatActive: boolean;
}

/** Section name -> the text last sent for it. */
export type SentSections = Readonly<Record<string, string>>;

/**
 * The sections whose text differs from what was last sent, as one message
 * body, plus the record to keep for next time. `note` is null when nothing
 * changed, which is the common case: no message, prefix untouched.
 */
export function contextNote(
	state: ContextState,
	sent: SentSections,
): { note: string | null; sent: SentSections } {
	const current: Record<string, string> = {
		memory: state.memory.trim(),
		appended:
			state.appendedContext.length > 0
				? `${APPENDED_HEADING}\n${state.appendedContext.map((c, i) => `[${i + 1}] ${c}`).join("\n")}`
				: sent.appended
					? `${APPENDED_HEADING}\n(none)`
					: "",
		voice: state.voiceChatActive ? VOICE_ON : sent.voice ? VOICE_OFF : "",
	};
	const changed = Object.keys(current).filter((k) => current[k] !== (sent[k] ?? ""));
	if (changed.length === 0) return { note: null, sent };
	return {
		note: [CONTEXT_NOTE_HEADER, ...changed.map((k) => current[k])].join("\n\n"),
		sent: { ...sent, ...current },
	};
}
