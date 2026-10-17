/**
 * Spoken post-draft (L2). After a full reply is on screen, a second short pass
 * rewrites it for the ear, and that draft is what gets spoken. The screen text
 * is never touched.
 *
 * Two stages:
 *   1. prepareForSpeech: deterministic. Drops code fences, URLs and file paths
 *      (summarised, never read aloud), strips markdown, says symbols and numbers
 *      the way people say them. The model never has to do this.
 *   2. makeSpokenDraft: one short fixed instruction to the same local model, then
 *      the same clean-up again on its output. If the model is slow, down or
 *      returns nothing, the deterministic text is spoken instead, so voice never
 *      goes quiet because a rewrite failed.
 */

export const SPOKEN_DRAFT_MAX_CHARS = 900;
export const SPOKEN_DRAFT_TIMEOUT_MS = 20_000;

/** The one fixed instruction. Short on purpose: small local models read the start. */
export const SPOKEN_DRAFT_INSTRUCTION =
	"Rewrite this reply to be spoken aloud to one person. Key point first. " +
	"Short sentences, plain words, the way you would say it out loud. " +
	"No lists, no markdown, no code, no file paths, no web addresses. " +
	"Keep it to a few sentences. Reply with only the spoken words.\n\nReply:\n";

const SYMBOLS: Array<[RegExp, string]> = [
	[/\s*(?:=>|->|→)\s*/g, " to "],
	[/\s*!==?\s*/g, " is not "],
	[/\s*(?:===|==)\s*/g, " equals "],
	[/\s*&&\s*/g, " and "],
	[/\s*\|\|\s*/g, " or "],
	[/\s&\s/g, " and "],
	[/(\d)\s*%/g, "$1 percent"],
	[/(\d)\s*×\s*(\d)/g, "$1 times $2"],
	[/(\d)\s*[–-]\s*(\d)/g, "$1 to $2"],
	[/\bw\/o\b/gi, "without"],
	[/\bw\//gi, "with "],
	[/\be\.g\./gi, "for example"],
	[/\bi\.e\./gi, "that is"],
	[/(?:^|\s)#(\d+)\b/g, " number $1"],
	[/(\d),(\d{3})(?!\d)/g, "$1$2"],
];

const DASHES = new RegExp(`\\s*[${String.fromCharCode(0x2014, 0x2013)}]\\s*`, "g");

function basename(p: string): string {
	const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
	return parts[parts.length - 1] || p;
}

/** Deterministic clean-up so the ear never hears syntax. Pure and idempotent enough to run twice. */
export function prepareForSpeech(input: string): string {
	let t = String(input ?? "").replace(/\r\n?/g, "\n");

	// Fenced code (closed, or left open by a cut-off reply) becomes one spoken cue.
	t = t.replace(/(```|~~~)[^\n]*\n[\s\S]*?(?:\1|$)/g, "\nThere is a code block on screen.\n");
	// Tables and rules carry no speech value.
	t = t.replace(/^\s*\|.*\|\s*$/gm, "").replace(/^\s*[-*_]{3,}\s*$/gm, "");

	// Links: keep the words, drop the address.
	t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
	t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
	t = t.replace(/\b(?:https?|ftp):\/\/[^\s)>\]]+/gi, "a link");
	t = t.replace(/\bwww\.[^\s)>\]]+/gi, "a link");

	// Paths: summarise as the file name, never the whole path.
	t = t.replace(/(?:~|\.{1,2}|[A-Za-z]:)?(?:[\\/][\w.@+-]+){2,}[\\/]?(?::\d+(?::\d+)?)?/g, (m) => {
		const name = basename(m.replace(/:\d+(?::\d+)?$/, ""));
		return name ? `the file ${name}` : "a file";
	});

	// Inline code: say the word, lose the ticks.
	t = t.replace(/`([^`\n]+)`/g, "$1");

	// Markdown structure.
	t = t.replace(/^\s{0,3}#{1,6}\s+(.*)$/gm, "$1.");
	t = t.replace(/^\s*>\s?/gm, "");
	t = t.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "");
	t = t.replace(/(\*\*|__)(.*?)\1/g, "$2").replace(/(\*|_)([^*_\n]+)\1/g, "$2");
	t = t.replace(/~~(.*?)~~/g, "$1");

	// Dashes read as a pause; symbols read as words.
	t = t.replace(DASHES, ", ");
	for (const [re, to] of SYMBOLS) t = t.replace(re, to);
	t = t.replace(/[*_`#|<>{}[\]\\^~]/g, " ");

	// Tidy whitespace: one paragraph break becomes a sentence break.
	t = t
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => (/[.!?:]$/.test(l) ? l : `${l}.`))
		.join(" ");
	t = t
		.replace(/\s{2,}/g, " ")
		.replace(/\s+([,.;:!?])/g, "$1")
		.replace(/\.{2,}/g, ".")
		.replace(/,\s*\./g, ".");
	// A draft must never start with "-": `say` would read it as an option.
	return t.trim().replace(/^[-\s]+/, "");
}

/** Cut at a sentence end at or before max, so speech never stops mid-word. */
export function capAtSentence(text: string, max = SPOKEN_DRAFT_MAX_CHARS): string {
	if (text.length <= max) return text;
	const head = text.slice(0, max);
	const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
	return cut > max * 0.4 ? head.slice(0, cut + 1) : `${head.slice(0, head.lastIndexOf(" "))}.`;
}

export type SpokenModel = (prompt: string, signal?: AbortSignal) => Promise<string>;

/**
 * The text to speak for a full reply. Never throws; always returns something
 * speakable unless the reply itself has nothing to say.
 */
export async function makeSpokenDraft(
	reply: string,
	model?: SpokenModel | null,
	timeoutMs = SPOKEN_DRAFT_TIMEOUT_MS,
): Promise<string> {
	const prepared = prepareForSpeech(reply);
	if (!prepared) return "";
	const fallback = capAtSentence(prepared);
	if (!model) return fallback;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const ctl = new AbortController();
	try {
		const draft = await Promise.race([
			model(SPOKEN_DRAFT_INSTRUCTION + prepared.slice(0, 6000), ctl.signal),
			new Promise<string>((_, rej) => {
				timer = setTimeout(() => {
					ctl.abort();
					rej(new Error("spoken draft timed out"));
				}, timeoutMs);
			}),
		]);
		const cleaned = prepareForSpeech(String(draft ?? ""));
		return cleaned ? capAtSentence(cleaned) : fallback;
	} catch {
		return fallback;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export interface SpokenQueueDeps {
	/** Speech is now pending (push-to-talk must stay shut). */
	start: () => void;
	/** Pending ends. Called after play, so a started utterance is already tracked. */
	end: () => void;
}

/**
 * Drafts one at a time, in order. Each reply is pending from the moment it is
 * queued until its draft is played or has failed.
 */
export function createSpokenQueue(deps: SpokenQueueDeps) {
	let tail: Promise<void> = Promise.resolve();
	return {
		enqueue(
			reply: string,
			model: SpokenModel | null | undefined,
			play: (draft: string) => void,
		): Promise<void> {
			deps.start();
			const run = tail.then(async () => {
				try {
					const draft = await makeSpokenDraft(reply, model);
					if (draft) play(draft);
				} catch {
					// A failed draft is silence, never a crash.
				} finally {
					deps.end();
				}
			});
			tail = run;
			return run;
		},
	};
}
