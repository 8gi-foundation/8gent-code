/**
 * A chat-only message gets a reply before any tool (#4982).
 *
 * "I just wanted to hear the voice TTS" is a statement about the person, not a
 * task. The act-first rules met it and ran 111 tool calls. This is the rule that
 * says, by pattern and not by a model call, that such a message is answered
 * first with no tools; a reply that then asks for tools gets them next round.
 *
 * Deliberately narrow and safe by default: when in doubt the answer is false,
 * which leaves the turn exactly as it was. A message that asks for work (a verb
 * like run, fix, build; a path, a URL, a code fence, a shell-looking token, a
 * slash command) is never chat-only, however it is phrased or spoken.
 */

const MAX_CHARS = 120;

/** Work verbs and request frames: any of these makes the message a task. */
const TASK =
	/\b(?:run|runs|running|fix|build|create|write|edit|delete|remove|install|deploy|commit|push|pull|merge|refactor|implement|add|update|change|make|open|launch|start|stop|kill|restart|check|tests?|testing|tested|fail(?:ed|ing|s)?|debug|search|find|show|list|read|look|fetch|download|upload|generate|install|set up|setup|configure|please|you to|go ahead|do it)\b/;

const SHELL =
	/(?:&&|\|\||[|;<>`]|\$\(|\$\{|\$[a-z_]|(?:^|\s)--?[a-z][\w-]*(?:\s|=|$)|^(?:sudo|git|npm|bun|bunx|npx|yarn|pnpm|ls|cd|cat|rm|mv|cp|curl|wget|brew|pip|python|node|docker|ssh|chmod|grep|find|echo|say)\b)/i;

const PATH = /(?:^|\s)(?:~|\.{1,2})?\/\S|\\\S|\b[\w-]+\/[\w-]+/i;
const FILE_EXT =
	/\b[\w-]+\.(?:ts|tsx|js|jsx|json|md|py|sh|rs|go|css|html|yml|yaml|toml|txt|swift|kt)\b/i;
const URL = /\b(?:https?:\/\/|www\.)\S+/i;

const GREETING =
	/^(?:hi+|hey+|hello+|yo+|hiya|howdy|good (?:morning|afternoon|evening|night)|gm)\b/i;
const THANKS =
	/^(?:thanks|thank you|thx|ty|cheers|bye|goodbye|good night|see you|see ya|talk later|never ?mind)\b/i;
const FIRST_PERSON = /^(?:i|i'm|im|i've|ive|i'd|id|i'll|ill|we|we're|my|let's|lets)\b/i;
const SELF_QUESTION =
	/^(?:what|who|how|why|which|where|when|do|does|did|are|is|can|will)\b.*\b(?:you|your|yourself|8gent|eight)\b.*\?$/i;

export interface ChatOnlyOptions {
	/** The voice path marked this message as a spoken utterance. Kept for callers; the pattern rules are the same. */
	spoken?: boolean;
}

/** True when the message asks for no work and deserves a reply before any tool. */
export function isChatOnly(text: string, opts: ChatOnlyOptions = {}): boolean {
	const t = text.trim().replace(/^\[mode: [^\]]*\]\s*/, "");
	if (t.length === 0 || t.length > MAX_CHARS) return false;
	if (t.startsWith("/") || t.includes("```") || t.includes("\n")) return false;
	if (URL.test(t) || FILE_EXT.test(t) || PATH.test(t) || SHELL.test(t)) return false;
	if (TASK.test(t.toLowerCase())) return false;
	// Spoken or typed, a message must still read as chat. A spoken question about
	// state ("are the tests passing") needs the tools to be answered truthfully.
	return GREETING.test(t) || THANKS.test(t) || FIRST_PERSON.test(t) || SELF_QUESTION.test(t);
}
