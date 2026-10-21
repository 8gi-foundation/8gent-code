/**
 * The COMPLETED line is a fixed form (#4713):
 *   COMPLETED: <what shipped>. <pushed|deployed|blocked|failed|done>.
 * Under 25 words, no quotation marks, nothing after the state word.
 *
 * A line that already fits is returned untouched. One that does not is cut to
 * its first sentence plus the state word. Nothing is invented: the state word
 * comes from the model's own line, and only when it named none is the plain
 * word "done" used. Other lines in the reply are never touched.
 */

export const COMPLETED_STATES = ["pushed", "deployed", "blocked", "failed", "done"] as const;
const STATE = COMPLETED_STATES.join("|");
const MAX_WORDS = 24;
const LINE = /^([ \t]*(?:[>*-][ \t]*)*(?:🎯\s*)?COMPLETED:)[ \t]*(.*)$/m;
const FIXED = new RegExp(`^[^.!?]+\\.\\s+(?:${STATE})\\.$`, "i");
const HAS_QUOTE = /["\u201C\u201D]/;
const QUOTES = /["“”]/g;

const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

export interface CompletedFix {
	text: string;
	trimmed: boolean;
}

export function fixCompletedLine(reply: string): CompletedFix {
	const m = LINE.exec(reply);
	if (!m) return { text: reply, trimmed: false };
	const [whole, head, rawBody = ""] = m;
	if (words(rawBody) <= MAX_WORDS && !HAS_QUOTE.test(rawBody) && FIXED.test(rawBody.trim())) {
		return { text: reply, trimmed: false };
	}
	const body = rawBody.replace(QUOTES, "").trim();
	const sentences = body.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== "");
	let first = (sentences[0] ?? "").replace(/[.!?]+$/, "").trim();
	let state: string | undefined;
	for (const s of sentences.slice(1)) {
		const w = s
			.replace(/[.!?]+$/, "")
			.trim()
			.toLowerCase();
		if ((COMPLETED_STATES as readonly string[]).includes(w)) {
			state = w;
			break;
		}
	}
	if (state === undefined) {
		const tail = first.match(new RegExp(`^(.*?)[,\\s]+(${STATE})$`, "i"));
		if (tail?.[1] && tail[2]) {
			first = tail[1];
			state = tail[2].toLowerCase();
		}
	}
	// A block or failure keeps its reason: two sentences, and the state word is never "done".
	const lead = first.toLowerCase();
	if (lead === "blocked" || lead === "failed") {
		const reason = (sentences[1] ?? "").replace(/[.!?]+$/, "").trim();
		const isState = (COMPLETED_STATES as readonly string[]).includes(reason.toLowerCase());
		first = reason && !isState ? `${first}. ${reason}` : first;
		state = lead;
	}
	state ??= "done";
	const kept = first
		.split(/\s+/)
		.slice(0, MAX_WORDS - 1)
		.join(" ");
	const line = `${head} ${kept}. ${state}.`;
	console.debug(
		`[completed-gate] trimmed COMPLETED line from ${words(rawBody)} to ${words(`${kept} ${state}`)} words`,
	);
	return { text: reply.replace(whole, line), trimmed: true };
}
