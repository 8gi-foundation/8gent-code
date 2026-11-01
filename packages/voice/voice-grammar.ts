/**
 * @8gent/voice — Shared Voice Grammar
 *
 * The single source of truth for what a spoken utterance *means* in 8gent.
 * A raw Whisper transcript is free-form English; this module turns it into a
 * canonical {@link VoiceIntent} so the same phrase drives the same action on
 * every surface — the Ink TUI, 8gent Flow, and the daemon.
 *
 * Two kinds of utterance:
 *   1. A *command* — a lifecycle verb ("approve", "dispatch", "stop", "merge")
 *      or a dictation-control verb ("scratch that", "new line", "send it").
 *   2. *Dictation* — everything else, which is the text the user is composing.
 *
 * The parser is intentionally conservative on the lifecycle verbs (approve /
 * dispatch / merge / stop): a false positive can ship or kill real work, so
 * those only match a short, deliberate utterance, never a word buried in a
 * long dictated sentence. Dictation is the safe default.
 *
 * This is pure logic with no I/O, so it is fully testable without a mic and is
 * the shared contract referenced by issue #2759 step 5 ("shared voice grammar
 * with Flow so commands mean the same thing on every surface").
 */

// ============================================
// Canonical intents
// ============================================

/**
 * The canonical set of voice intents. These names are the shared vocabulary;
 * every surface maps them to its own concrete action (the TUI submits the
 * input buffer for `submit`, Flow dispatches a mission for `dispatch`, etc.).
 */
export type VoiceIntent =
	// Dictation-control
	| "dictate" // default: the text is content to compose, not a command
	| "submit" // send the composed input / confirm the current prompt
	| "scratch" // clear the current input buffer
	| "undo_word" // remove the last dictated word
	| "newline" // insert a line break
	// Lifecycle (the hands-free build loop)
	| "approve" // approve a plan / a pending action / a dispatch
	| "reject" // reject / decline the pending action
	| "dispatch" // dispatch the approved plan to the agent fleet
	| "steer" // send a mid-flight correction to the running agent
	| "merge" // approve and merge the finished work
	| "stop" // abort / cancel the running work
	// Session
	| "help" // read the available voice commands
	| "repeat" // repeat the last spoken response
	| "cancel"; // dismiss the current voice interaction, keep the session

export interface VoiceCommand {
	/** The canonical intent this utterance maps to. */
	intent: VoiceIntent;
	/**
	 * The residual argument text, when the intent carries one. For `dictate`
	 * this is the full (cleaned) utterance; for `steer` it is the correction
	 * ("steer: use the other endpoint" -> "use the other endpoint"); for a
	 * bare command it is an empty string.
	 */
	arg: string;
	/**
	 * Confidence in the match, 0-1. Bare lifecycle verbs score high; dictation
	 * is always 1 (it is the safe fallback, never a misfire).
	 */
	confidence: number;
	/** True for every intent except `dictate`. */
	isCommand: boolean;
	/** The cleaned transcript the match was made against. */
	normalized: string;
}

// ============================================
// Whisper artifact cleanup
// ============================================

/**
 * Whisper.cpp emits bracketed non-speech markers on silence or noise, e.g.
 * `[BLANK_AUDIO]`, `[ Silence ]`, `(music)`, `*laughs*`. They are never user
 * intent, so we strip them before matching.
 */
const NON_SPEECH_MARKER = /[\[(*][^\])*]*[\])*]/g;

/**
 * Normalize a raw transcript: strip non-speech markers, collapse whitespace,
 * lowercase, and drop trailing sentence punctuation. Kept exported because
 * every surface needs the exact same normalization to stay in lockstep.
 */
export function normalizeTranscript(raw: string): string {
	return raw
		.replace(NON_SPEECH_MARKER, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase()
		.replace(/[.!?,;:]+$/g, "")
		.trim();
}

// ============================================
// Wake word
// ============================================

/**
 * Common ways Whisper mishears the "hey eight" wake word. Kept generous on the
 * recognition side (cheap) and exact on the action side (a wake word only ever
 * *arms* listening, it never ships work).
 */
const WAKE_VARIANTS = [
	"hey eight",
	"hey eighth",
	"hey ate",
	"hey agent",
	"hey 8gent",
	"hey agent code",
	"okay eight",
	"ok eight",
];

/**
 * If `text` opens with a wake word, return the remainder (which may be empty,
 * meaning "just wake up"). Returns `null` when no wake word is present. Case-
 * and punctuation-insensitive.
 */
export function stripWakeWord(text: string, extraVariants: string[] = []): string | null {
	const normalized = normalizeTranscript(text);
	const variants = [...WAKE_VARIANTS, ...extraVariants.map((v) => v.toLowerCase())];
	for (const wake of variants) {
		if (normalized === wake) return "";
		if (normalized.startsWith(`${wake} `)) {
			return normalized.slice(wake.length + 1).trim();
		}
		if (normalized.startsWith(`${wake}, `)) {
			return normalized.slice(wake.length + 2).trim();
		}
	}
	return null;
}

// ============================================
// Phrase tables
// ============================================

/**
 * Exact-phrase triggers for each command intent. A command fires only when the
 * whole (normalized) utterance is one of these phrases — this is what keeps
 * "approve the change in file X" (a dictated request) from being read as the
 * bare `approve` lifecycle command.
 */
const EXACT_PHRASES: Record<Exclude<VoiceIntent, "dictate" | "steer">, string[]> = {
	submit: ["submit", "send", "send it", "send that", "go", "enter", "run it", "do it"],
	scratch: ["scratch that", "clear", "clear that", "clear input", "delete that", "never mind"],
	undo_word: ["undo", "undo that", "back", "backspace", "delete word"],
	newline: ["new line", "newline", "line break"],
	approve: ["approve", "approved", "approve it", "yes", "yep", "confirm", "confirmed", "looks good", "lgtm", "accept"],
	reject: ["reject", "no", "nope", "decline", "deny", "reject it", "change it"],
	dispatch: ["dispatch", "dispatch it", "ship it", "start", "begin", "go build", "kick it off", "run the plan"],
	merge: ["merge", "merge it", "land it", "merge the pr", "open the pr", "ship the pr"],
	stop: ["stop", "abort", "cancel that", "halt", "kill it", "stop it", "abort mission"],
	help: ["help", "what can i say", "voice help", "list commands", "commands"],
	repeat: ["repeat", "say that again", "again", "read that back", "what did you say"],
	cancel: ["cancel", "dismiss", "close this", "go back"],
};

/**
 * Prefix triggers for the argument-carrying intents. When the utterance opens
 * with one of these, the remainder becomes the command's `arg`.
 */
const PREFIX_TRIGGERS: { intent: VoiceIntent; prefixes: string[] }[] = [
	{ intent: "steer", prefixes: ["steer", "correction", "actually", "instead", "no wait", "change it to", "tell it to"] },
];

/**
 * Utterances shorter than this (in words) are eligible to be a bare lifecycle
 * command. A longer utterance is dictation even if it starts with a verb — the
 * user is describing work, not issuing a one-word command.
 */
const MAX_COMMAND_WORDS = 4;

// Build a reverse lookup once at module load: phrase -> intent.
const PHRASE_TO_INTENT = new Map<string, VoiceIntent>();
for (const [intent, phrases] of Object.entries(EXACT_PHRASES)) {
	for (const phrase of phrases) {
		PHRASE_TO_INTENT.set(phrase, intent as VoiceIntent);
	}
}

// ============================================
// Parser
// ============================================

/**
 * Parse a raw Whisper transcript into a canonical {@link VoiceCommand}.
 *
 * Resolution order:
 *   1. Empty / non-speech only  -> `cancel` (nothing was said).
 *   2. Exact-phrase command     -> that intent, high confidence.
 *   3. Argument-carrying prefix  -> that intent with the remainder as `arg`.
 *   4. Everything else           -> `dictate` (the safe default).
 *
 * @param raw the transcript straight from the STT engine.
 */
export function parseVoiceCommand(raw: string): VoiceCommand {
	const normalized = normalizeTranscript(raw);

	// 1. Nothing meaningful was said (silence / pure non-speech markers).
	if (normalized.length === 0) {
		return { intent: "cancel", arg: "", confidence: 1, isCommand: true, normalized };
	}

	const wordCount = normalized.split(" ").length;

	// 2. Exact bare command — only for short, deliberate utterances so a verb
	// buried in a dictated sentence never fires a lifecycle action.
	if (wordCount <= MAX_COMMAND_WORDS) {
		const intent = PHRASE_TO_INTENT.get(normalized);
		if (intent) {
			return { intent, arg: "", confidence: 0.98, isCommand: true, normalized };
		}
	}

	// 3. Argument-carrying prefix (e.g. "steer: use the other endpoint").
	for (const { intent, prefixes } of PREFIX_TRIGGERS) {
		for (const prefix of prefixes) {
			if (normalized === prefix) {
				// Bare prefix with no argument is not an actionable steer.
				continue;
			}
			// The prefix must be a whole leading token, followed by a separator
			// (space, comma, or colon) so "steering" never matches "steer".
			if (normalized.startsWith(prefix)) {
				const boundary = normalized.charAt(prefix.length);
				if (boundary === " " || boundary === "," || boundary === ":") {
					const arg = normalized
						.slice(prefix.length)
						.replace(/^[\s,:]+/, "")
						.trim();
					if (arg.length > 0) {
						return { intent, arg, confidence: 0.9, isCommand: true, normalized };
					}
				}
			}
		}
	}

	// 4. Default: dictation. Never a misfire — this is the composed text.
	return { intent: "dictate", arg: normalized, confidence: 1, isCommand: false, normalized };
}

/**
 * A one-line, human-readable listing of the spoken commands, for the `help`
 * intent and for screen-reader / onboarding surfaces. Grouped by lifecycle
 * stage so a keyboard-free user can learn the loop by ear.
 */
export const VOICE_COMMAND_HELP: { group: string; say: string; does: string }[] = [
	{ group: "Compose", say: "send it", does: "submit what you dictated" },
	{ group: "Compose", say: "scratch that", does: "clear the input" },
	{ group: "Compose", say: "undo", does: "remove the last word" },
	{ group: "Compose", say: "new line", does: "insert a line break" },
	{ group: "Review", say: "approve", does: "approve the plan or action" },
	{ group: "Review", say: "reject", does: "decline the pending action" },
	{ group: "Build", say: "dispatch", does: "start the approved plan" },
	{ group: "Build", say: "steer <correction>", does: "correct the running agent" },
	{ group: "Build", say: "stop", does: "abort the running work" },
	{ group: "Ship", say: "merge", does: "approve and merge the work" },
	{ group: "Session", say: "repeat", does: "hear the last response again" },
	{ group: "Session", say: "help", does: "read this list" },
];
