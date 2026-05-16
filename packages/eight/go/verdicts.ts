/**
 * 8DO-owned user-facing verdict copy for the /goal loop.
 *
 * Every string a person reads about a goal run flows through this module.
 * The /goal feature has six terminal or near-terminal moments, and each one
 * gets exactly one canonical sentence so the experience never drifts into
 * generic LLM voice ("I've successfully...", "Great news...", "Working
 * on it..."). The agent does not narrate its own labour. It reports
 * outcomes, in the operator's voice.
 *
 * Hard rules baked into this file and enforced by tests:
 *
 *   - No em dashes anywhere. Hyphens or commas.
 *   - No first-person AI-speak ("I", "I've", "I am").
 *   - No vendor names ("Claude", "Anthropic", "OpenAI").
 *   - No self-referential hedging ("AI", "model", "working on").
 *   - No congratulatory inflation ("successfully", "great news").
 *
 * The constants below are the contract. Anything that ships verdict copy
 * to a user MUST assemble it from these templates. If a new terminal state
 * appears, add a constant, add a lint test, do not freelance the wording.
 */

/** Run reached its goal under the confidence floor. */
export const VERDICT_DONE = "Done. Goal met at turn {n}.";

/** Run stopped for a reason that is not failure (budget, abort, user). */
export const VERDICT_STOPPED = "Stopped. {reason}.";

/** Run paused with an open question for the operator. */
export const VERDICT_NEEDS_YOU = "Needs you. {what}.";

/** Run is mid-flight, surfaced as a one-line status. */
export const VERDICT_STILL_GOING = "Still going. Sub-goal {x} of {y}.";

/** Three consecutive judge-dissent attempts on the same surface. */
export const VERDICT_STUCK =
	"Stuck. Needs you - last attempt failed three times the same way.";

/** Hard abandon: the loop could not get past a specific blocker. */
export const VERDICT_ABANDONED = "Stopped. Couldn't get past {reason}.";

/**
 * Kinds that can be assembled. Keeping this as a const-tuple union gives
 * callers exhaustive switch coverage in TypeScript without an enum's
 * runtime overhead.
 */
export type VerdictKind =
	| "done"
	| "stopped"
	| "needs_you"
	| "still_going"
	| "stuck"
	| "abandoned";

/**
 * Template lookup. Kept private so callers go through assembleVerdict
 * and cannot accidentally interpolate against a stale template.
 */
const TEMPLATES: Record<VerdictKind, string> = {
	done: VERDICT_DONE,
	stopped: VERDICT_STOPPED,
	needs_you: VERDICT_NEEDS_YOU,
	still_going: VERDICT_STILL_GOING,
	stuck: VERDICT_STUCK,
	abandoned: VERDICT_ABANDONED,
};

/**
 * Field shapes per verdict kind. Explicit union so a typo in the field
 * name is a compile error, not a silent "{n}" left in the user-facing
 * string.
 */
export type VerdictFields =
	| { kind: "done"; n: number }
	| { kind: "stopped"; reason: string }
	| { kind: "needs_you"; what: string }
	| { kind: "still_going"; x: number; y: number }
	| { kind: "stuck" }
	| { kind: "abandoned"; reason: string };

/**
 * Tokens that must never appear in any verdict the operator sees. This
 * is the brand floor for the /goal feature, not a soft hint.
 *
 * Em dash is on the list per CLAUDE.md prohibition. Inclusion of "AI"
 * and "model" is deliberate: the agent is doing work for a person, it
 * is not the subject of the sentence.
 */
export const BANNED_TOKENS: readonly string[] = [
	"successfully",
	"great news",
	"I've",
	"I am",
	"working on",
	"AI",
	"model",
	"Claude",
	"Anthropic",
	"OpenAI",
	"—", // em dash, never inlined as a literal character
];

/**
 * Render a verdict from a kind plus typed fields. The kind also lives
 * inside `fields` so TypeScript can discriminate; the duplicated `kind`
 * argument is a defensive readability tax (call sites read top-down).
 */
export function assembleVerdict(
	kind: VerdictKind,
	fields: VerdictFields,
): string {
	if (fields.kind !== kind) {
		throw new Error(
			`assembleVerdict: kind/fields mismatch (kind=${kind}, fields.kind=${fields.kind})`,
		);
	}
	const tmpl = TEMPLATES[kind];

	let out = tmpl;
	switch (fields.kind) {
		case "done":
			out = out.replace("{n}", String(fields.n));
			break;
		case "stopped":
			out = out.replace("{reason}", sanitizeFreeText(fields.reason));
			break;
		case "needs_you":
			out = out.replace("{what}", sanitizeFreeText(fields.what));
			break;
		case "still_going":
			out = out.replace("{x}", String(fields.x)).replace("{y}", String(fields.y));
			break;
		case "stuck":
			// No interpolation. The template is the full string.
			break;
		case "abandoned":
			out = out.replace("{reason}", sanitizeFreeText(fields.reason));
			break;
	}

	assertNoBannedTokens(out);
	return out;
}

/**
 * Throw if `text` contains any banned token.
 *
 * Matching rules:
 *   - The em dash is matched as a literal character.
 *   - Multi-word phrases ("great news", "working on", "I am", "I've")
 *     are matched as substrings, case-insensitive. These phrases are
 *     long enough that substring matching is unambiguous.
 *   - Single-word tokens ("AI", "model", "Claude", "Anthropic",
 *     "OpenAI", "successfully") are matched on word boundaries,
 *     case-insensitive. This is critical: a substring match on "AI"
 *     would falsely flag "again", "fail", "main", which are common.
 *
 * Used both as a runtime guard inside assembleVerdict and as a lint
 * helper imported by tests so any new constant is checked on the way in.
 */
export function assertNoBannedTokens(text: string): void {
	if (typeof text !== "string") {
		throw new Error("assertNoBannedTokens: expected string");
	}
	for (const token of BANNED_TOKENS) {
		if (token === "—") {
			if (text.includes("—")) {
				throw new BannedTokenError("em dash", text);
			}
			continue;
		}

		// Multi-word phrases: case-insensitive substring match. Contractions
		// like "I've" are treated as phrases too because the apostrophe is
		// already a word-boundary signal on either side.
		if (token.includes(" ") || token.includes("'") || token.includes("’")) {
			if (text.toLowerCase().includes(token.toLowerCase())) {
				throw new BannedTokenError(token, text);
			}
			continue;
		}

		// Single-word token: word-boundary match so common substrings stay
		// allowed (e.g. "ai" inside "again").
		const re = new RegExp(
			`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
			"i",
		);
		if (re.test(text)) {
			throw new BannedTokenError(token, text);
		}
	}
}

/**
 * Distinct error class so callers can catch the lint failure without
 * accidentally swallowing other errors. Carries the offending token so
 * the test output reads cleanly.
 */
export class BannedTokenError extends Error {
	constructor(
		public readonly token: string,
		public readonly text: string,
	) {
		super(`verdict contains banned token "${token}": ${JSON.stringify(text)}`);
		this.name = "BannedTokenError";
	}
}

/**
 * Defensive cleaner for free-text fields passed into templates. The
 * caller already shouldn't ship em dashes through, but a single
 * accidental copy-paste shouldn't ship a typographical violation. We
 * normalize em-dashes to a hyphen + space and trim trailing punctuation
 * collisions so the final string doesn't read ". .".
 */
function sanitizeFreeText(value: string): string {
	if (typeof value !== "string") return "";
	let v = value.replace(/—/g, " - ");
	// Collapse double-spaces introduced by the replacement.
	v = v.replace(/ {2,}/g, " ").trim();
	// If the caller already ended with a period, drop it so the template's
	// trailing period doesn't double up.
	if (v.endsWith(".")) v = v.slice(0, -1);
	return v;
}
