/**
 * PreToolRouter — deterministic harness routing of retrieval strategy.
 *
 * Classifies a user's request BEFORE the LLM is invoked and picks the
 * cheapest correct retrieval (AST symbol lookup, grep literal, glob,
 * vector recall, or single-file read). The LLM then sees pre-fetched
 * context and avoids spending a turn on tool selection.
 *
 * Model-agnostic: weak local models (Gemma 4 26B-a4, small Qwens) get
 * the same correct routing as a frontier model.
 *
 * Concept extracted under CleanRoomPort rules from patterns observed
 * in StartupHakk/OpenMonoAgent (AGPL); no source copied. James's
 * design suggestion (2026-05-09) drove the heuristic ordering.
 *
 * Issue: 8gi-foundation/8gent-code#2471.
 */

export type RouterStrategy =
	| "ast"
	| "grep"
	| "glob"
	| "vector"
	| "fileread"
	| "none";

export interface RouterDecision {
	strategy: RouterStrategy;
	args: Record<string, unknown>;
	confidence: number;
	reason: string;
}

export interface ProjectContext {
	cwd: string;
	/** Optional list of file paths the harness already knows about. */
	knownFiles?: string[];
}

export interface PreToolRouterOptions {
	astAvailable: boolean;
	vectorAvailable: boolean;
}

// ── Heuristic patterns ────────────────────────────────────────────────
//
// Order of evaluation matters. Strongest signals first:
//   1. Quoted literal              → grep (very specific intent)
//   2. Glob-style wildcard         → glob (explicit pattern)
//   3. Concrete file path          → fileread (direct reference)
//   4. CamelCase / snake_case ID   → ast (or grep fallback)
//   5. Concept question            → vector (or grep fallback)
//   6. Greeting / very short       → none (let agent decide)

const QUOTED_LITERAL = /["']([^"']{2,80})["']/;
// A glob pattern needs an unquoted wildcard. Single * inside a word like
// "*.tsx" or a path segment "src/**" qualifies; a lone asterisk or one
// trailing punctuation character does not.
const GLOB_PATTERN = /(?:[\w./-]*\*\*?[\w./-]*|\*\.[A-Za-z]{1,6})/;
// Path-like token: at least one slash, ends in a known extension. Kept
// conservative so plain words ("foo/bar") don't match.
const FILE_PATH =
	/(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|md|json|yaml|yml|toml|css|scss|html|py|rs|go|swift|sh))(?=$|\s|[.,;:!?])/;
// CamelCase: at least one lower→upper transition. snake_case: at least
// one underscore between word chars. Both must be >=4 chars to avoid
// noise like "iOS" or "a_b".
const CAMEL_CASE = /\b([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]{2,})\b/;
const SNAKE_CASE = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+){1,})\b/;

const CONCEPT_PHRASES = [
	/^how does\b/i,
	/^how do\b/i,
	/^what is\b/i,
	/^what are\b/i,
	/^why does\b/i,
	/^explain\b/i,
	/^tell me about\b/i,
	/^describe\b/i,
];

const GREETINGS = new Set([
	"hi",
	"hey",
	"hello",
	"yo",
	"sup",
	"howdy",
	"morning",
	"evening",
	"thanks",
	"ok",
	"okay",
	"cool",
	"nice",
]);

function stripPunctuation(s: string): string {
	return s.replace(/[.,;:!?]+$/g, "").trim();
}

function isGreeting(message: string): boolean {
	const stripped = stripPunctuation(message.toLowerCase()).trim();
	if (stripped.length === 0) return true;
	const words = stripped.split(/\s+/);
	if (words.length > 3) return false;
	return words.every((w) => GREETINGS.has(stripPunctuation(w)));
}

function matchesConceptQuestion(message: string): boolean {
	return CONCEPT_PHRASES.some((p) => p.test(message.trim()));
}

// ── Router ────────────────────────────────────────────────────────────

export class PreToolRouter {
	constructor(private readonly opts: PreToolRouterOptions) {}

	classify(userMessage: string, _projectContext: ProjectContext): RouterDecision {
		const msg = userMessage ?? "";
		const trimmed = msg.trim();

		if (trimmed.length === 0 || isGreeting(trimmed)) {
			return {
				strategy: "none",
				args: {},
				confidence: 0.05,
				reason: "greeting or empty input — no retrieval needed",
			};
		}

		// 1. Quoted literal → grep. This wins over everything else because
		//    quotes are an explicit, intentional signal from the user.
		const quoted = trimmed.match(QUOTED_LITERAL);
		if (quoted) {
			return {
				strategy: "grep",
				args: { pattern: quoted[1] },
				confidence: 0.9,
				reason: "literal in quotes — exact-string search",
			};
		}

		// 2. Glob pattern. Must be wildcarded; bare file paths fall through
		//    to fileread below.
		const glob = trimmed.match(GLOB_PATTERN);
		if (glob && /\*/.test(glob[0])) {
			return {
				strategy: "glob",
				args: { pattern: glob[0] },
				confidence: 0.85,
				reason: "glob-style wildcard pattern",
			};
		}

		// 3. Concrete file path with a recognised extension → fileread.
		const file = trimmed.match(FILE_PATH);
		if (file) {
			return {
				strategy: "fileread",
				args: { path: file[1] },
				confidence: 0.85,
				reason: "explicit file path with known extension",
			};
		}

		// 4. CamelCase or snake_case identifier → ast (or grep fallback).
		const camel = trimmed.match(CAMEL_CASE);
		const snake = trimmed.match(SNAKE_CASE);
		const symbol = camel?.[1] ?? snake?.[1];
		if (symbol) {
			if (this.opts.astAvailable) {
				return {
					strategy: "ast",
					args: { symbol },
					confidence: 0.8,
					reason: "identifier looks like a symbol (camelCase/snake_case)",
				};
			}
			return {
				strategy: "grep",
				args: { pattern: symbol },
				confidence: 0.7,
				reason: "ast unavailable — grep on the symbol name",
			};
		}

		// 5. Concept question with no symbol/literal → vector (or grep
		//    fallback on a salient noun phrase).
		if (matchesConceptQuestion(trimmed)) {
			if (this.opts.vectorAvailable) {
				return {
					strategy: "vector",
					args: { query: trimmed },
					confidence: 0.7,
					reason: "concept query with no symbol — semantic recall",
				};
			}
			const fallbackPattern = pickKeyTerm(trimmed);
			return {
				strategy: "grep",
				args: { pattern: fallbackPattern },
				confidence: 0.55,
				reason: "vector unavailable — grep on key term from question",
			};
		}

		// 6. Default fallback.
		return {
			strategy: "none",
			args: {},
			confidence: 0.2,
			reason: "no deterministic signal — defer to agent loop",
		};
	}
}

/** Pick the most salient term from a concept question for grep fallback. */
function pickKeyTerm(question: string): string {
	const stop = new Set([
		"how",
		"does",
		"do",
		"the",
		"is",
		"are",
		"a",
		"an",
		"of",
		"in",
		"on",
		"to",
		"for",
		"and",
		"or",
		"what",
		"why",
		"explain",
		"tell",
		"me",
		"about",
		"describe",
		"work",
		"works",
	]);
	const words = question
		.toLowerCase()
		.replace(/[^a-z0-9_\s]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2 && !stop.has(w));
	// Prefer the longest remaining word as the most distinctive term.
	words.sort((a, b) => b.length - a.length);
	return words[0] ?? question.trim();
}

/**
 * Format a router decision and its retrieval result as a system message
 * that the agent loop can inject before the first LLM turn.
 */
export function formatPreFetchedContext(
	decision: RouterDecision,
	result: string,
): string {
	const argLines = Object.entries(decision.args)
		.map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
		.join("\n");
	const truncated = result.length > 4000 ? `${result.slice(0, 4000)}\n... [truncated]` : result;
	return [
		"[PRE-FETCHED CONTEXT]",
		`Strategy: ${decision.strategy} (confidence ${decision.confidence.toFixed(2)})`,
		`Reason: ${decision.reason}`,
		"Args:",
		argLines || "  (none)",
		"",
		"Result:",
		truncated,
	].join("\n");
}
