/**
 * build-intent.ts - detect when a plain TUI message is an imperative build
 * request, so the agent can route it into the adaptive pipeline without the
 * user typing `/build`.
 *
 * Deliberately conservative. It fires only on a clear imperative ("build a
 * ...", "can you create a ...") and stays out of the way of informational
 * questions ("how do I build a docker image") and short remarks ("the build
 * broke"). A false positive costs a multi-minute pipeline run, so the bar to
 * trigger is high - precision over recall.
 */

/** Verbs that mean "produce an artifact". */
const BUILD_VERBS = new Set([
	"build",
	"rebuild",
	"create",
	"generate",
	"scaffold",
	"construct",
	"make",
]);

/** Informational question openers - never a build command. */
const INFO_QUESTION_START = /^(how|what|whats|why|when|where|which|who|whose|is|are|does|do|should|could i|can i)\b/;

/** Polite-request framing stripped before the verb check. */
const REQUEST_PREFIX =
	/^(please|hey|ok|okay|now|can you|could you|would you|will you|i want you to|i'?d like you to|i would like you to|i need you to|lets|let's)\s+/;

/**
 * Returns the build task (the original message) when the message is a clear
 * imperative build request, or `null` when it is not and should go to the
 * normal agent.
 */
export function detectBuildIntent(message: string): string | null {
	const trimmed = message.trim();
	if (!trimmed || trimmed.startsWith("/")) return null;
	// A real build spec carries detail; a terse line almost never does.
	if (trimmed.length < 15) return null;

	const lower = trimmed.toLowerCase();
	// Informational questions are not build commands ("how do I build ...").
	if (INFO_QUESTION_START.test(lower)) return null;

	// Strip polite-request framing so "can you build a ..." still resolves
	// to the verb "build".
	const stripped = lower.replace(REQUEST_PREFIX, "");
	const words = stripped.split(/\s+/);
	const firstWord = (words[0] ?? "").replace(/[^a-z]/g, "");
	if (!BUILD_VERBS.has(firstWord)) return null;

	// "make sure ..." / "make it ..." are not artifact builds.
	if (firstWord === "make" && (words[1] === "sure" || words[1] === "it")) {
		return null;
	}

	return trimmed;
}
