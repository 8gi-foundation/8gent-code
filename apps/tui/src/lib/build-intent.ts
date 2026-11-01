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
 * Web artifacts the adaptive pipeline can actually produce. It writes one
 * self-contained HTML file (packages/orchestration/adaptive-pipeline.ts), so
 * only these route; any other build verb falls through to the agent (#3323).
 */
const WEB_ARTIFACT =
	/\b(web ?pages?|pages?|(micro|web)?sites?|landing|homepage|hero|portfolio|dashboard|games?|demo|animations?|animated|visuali[sz]ations?|viz|html|canvas|three\.?js|webgl|shaders?|3d)\b/;

/**
 * Signals of a repo task the pipeline cannot do: a backtick command, a path
 * ("deck/deck.md", "packages/decide") or a file extension other than .html.
 * "three.js" is a library name, not a file, so it is removed first.
 */
const REPO_COMMAND = /`/;
const REPO_PATH = /[\w.-]\/[\w.-]/;
const NON_HTML_FILE = /\b[\w-]+\.(?!html?\b)[a-z][a-z0-9]{0,4}\b/;

/**
 * Other signals that the ask is not "a new one-page web thing" (#3323, #3325):
 *  - NON_HTML_FORMAT: the output is a format the HTML pipeline can never emit
 *    ("sitemap xml", "slide deck", "docs"), with or without a file extension.
 *  - REPO_WORK: framework or git vocabulary, or "in the app/repo", which means
 *    work inside the user's codebase.
 *  - EXISTING_TARGET: the verb is followed by the|our|my|this|these, as in
 *    "make the login page match the new brand colours" or "build my
 *    portfolio site with a contact form". That names a thing that already
 *    exists, so it is an edit. "rebuild the X" stays routable (an explicit
 *    rebuild of a page).
 */
const NON_HTML_FORMAT =
	/\b(xml|json|csv|ya?ml|markdown|md|pdf|marp|slides?|decks?|site ?maps?|readme|docs?|documentation)\b/;
const REPO_WORK =
	/\b(react|vue|svelte|angular|next\.?js|tailwind|typescript|components?|prs?|pull requests?|commits?|branch(es)?|merge)\b|\b(in|into|inside) (the|our|my|this) (app|repo|codebase|project|code)\b/;
const EXISTING_TARGET = /^[a-z]+\s+(the|our|my|this|these)\b/;

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
	// The regexes below are quadratic on long spaceless input; a real build
	// ask is never this long, so bail before they run (#3325).
	if (trimmed.length > 4000) return null;

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

	// Only a web artifact with no repo paths, files or commands routes (#3323).
	if (!WEB_ARTIFACT.test(lower)) return null;
	if (REPO_COMMAND.test(lower) || REPO_PATH.test(lower)) return null;
	if (NON_HTML_FILE.test(lower.replace(/three\.js/g, "threejs"))) return null;

	if (NON_HTML_FORMAT.test(lower) || REPO_WORK.test(lower)) return null;
	if (firstWord !== "rebuild" && EXISTING_TARGET.test(stripped)) return null;

	return trimmed;
}
