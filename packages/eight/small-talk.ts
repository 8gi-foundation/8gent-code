/**
 * Small-talk gate (#4756).
 *
 * "what upp" typed in a non-repo $HOME on a phone got ten shell calls and a
 * folder tour. The prompt rules that push the model to act (RULES_SEGMENT in
 * prompts/system-prompt.ts: "NEVER give tutorials - USE TOOLS directly", "DO IT")
 * have no case for a message that asks for nothing. This is that case, decided
 * by a pattern and not by a model call: a greeting or a pleasantry, alone, is
 * answered with no tools offered for the turn.
 *
 * Deliberately narrow. The whole message must be the greeting (so "hi, run the
 * tests" and "what up with the build" are not small talk), at most one leading
 * greeting word and one trailing address word. Same input, same answer.
 */

const CORE = [
	"h+i+",
	"h+e+y+",
	"h+e+l+o+",
	"hiya",
	"howdy",
	"y+o+",
	"sup",
	"wa+s+s?u+p+",
	"w?h?a+t?s? ?u+p+",
	"good (?:morning|afternoon|evening|night)",
	"gm",
	"gn",
	"morning",
	"evening",
	"how are you(?: doing| today)?",
	"how are things",
	"hows it going",
	"how you doing",
	"you there",
	"anyone there",
	"ping",
	"thanks(?: a lot| so much)?",
	"thank you(?: so much)?",
	"thx",
	"ty",
	"cheers",
	"ok(?:ay)?",
	"cool",
	"nice",
	"great",
].join("|");

const GREETING = new RegExp(
	`^(?:(?:hi+|hey+|hello+|yo+|hiya|howdy) )?(?:${CORE})(?: (?:there|again|everyone|all|team|mate|man|bro|friend|8gent|eight))?$`,
);

/** True when the whole message is a greeting or pleasantry that asks for no work. */
export function isSmallTalk(text: string): boolean {
	const flat = text
		.toLowerCase()
		.replace(/^\[mode: [^\]]*\]\s*/, "")
		.replace(/['’]/g, "")
		.replace(/[^a-z0-9 ]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length > 0 && flat.length <= 40 && GREETING.test(flat);
}

/** The harness note a small-talk turn carries, so the reply stays one line and no tour is announced. */
export const SMALL_TALK_NOTE =
	"[SMALL TALK] The person said hello and asked for nothing. Reply in one or two plain sentences and ask what they want to work on. No tools this turn: do not look around, list files or describe their folders.";
