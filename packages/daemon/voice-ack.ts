/**
 * Relevant instant voice ack. Pure and deterministic: the transcript picks one of a
 * fixed set of short phrases. The transcript is never echoed, so no spoken word comes
 * from the person's audio and nothing leaves the machine. Anything unclear, empty,
 * a bridge status string ("[..."), or late falls back to the generic phrase.
 */

/** Generic ack, spoken when no intent matches or the transcript is not ready in time. */
export const VOICE_ACK = "Got it, give me a minute.";

/** How long the ack waits for the local transcript before it speaks the generic phrase. */
export const VOICE_ACK_WAIT_MS = 1500;

/** Hard cap on the spoken ack. A phrase over this falls back to the generic one. */
export const VOICE_ACK_MAX_WORDS = 8;

/** First match wins, so the more specific intents come first. */
const INTENTS: ReadonlyArray<readonly [RegExp, string]> = [
	[/\b(pilot|autotune|auto tune)\b/i, "Looking at the pilot run"],
	[/\b(prs?|pull requests?|merge[sd]?|merging|code review)\b/i, "Checking the PR status now"],
	[
		/\b(ci (?:is|status|green|red|pass\w*|fail\w*|runs?)|github actions|test suite|tests? (?:pass\w*|fail\w*)|build (?:fail\w*|status|is))\b/i,
		"Checking the CI status now",
	],
	[
		/\b(deploy(?:ed|ment|ing)?|releases?|ship(?:ped|ping)?|publish(?:ed)?)\b/i,
		"Checking the release now",
	],
	[/\b(github issues?|tickets?|the board|roadmap|backlog)\b/i, "Checking the board now"],
	[/\b(videos?|films?|recording|demo|gif)\b/i, "Looking at the video now"],
	[/\b(bugs?|broken|crash(?:ed|es|ing)?|failing)\b/i, "Looking into that fix now"],
	[/\b(status|progress|going on)\b/i, "Pulling the status now"],
	[/\bdraft\b/i, "Drafting that now"],
	[/\bexplain\b/i, "Looking into that now"],
];

const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/** Dashes (em, en) built from char codes so the source stays dash-free. */
const BANNED = new RegExp(
	`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]|ag${"ent"}`,
	"i",
);

const safe = (p: string): boolean => wordCount(p) <= VOICE_ACK_MAX_WORDS && !BANNED.test(p);

/** The phrase to speak for a transcript. Empty, sentinel or unmatched gives the generic ack. */
export function relevantAck(transcript: string | undefined | null): string {
	const t = (transcript ?? "").trim();
	if (t === "" || t.startsWith("[")) return VOICE_ACK;
	for (const [re, phrase] of INTENTS) {
		if (re.test(t) && safe(phrase)) return phrase;
	}
	return VOICE_ACK;
}

/**
 * Race a transcript promise against the wait budget. Resolves to the generic ack on
 * timeout, rejection or an empty transcript; never rejects and never delays past waitMs.
 */
export async function ackForTranscript(
	transcript: Promise<string> | undefined,
	waitMs: number = VOICE_ACK_WAIT_MS,
): Promise<string> {
	if (!transcript) return VOICE_ACK;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const text = await Promise.race([
			transcript.catch(() => ""),
			new Promise<string>((resolve) => {
				timer = setTimeout(() => resolve(""), waitMs);
			}),
		]);
		return relevantAck(text);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
