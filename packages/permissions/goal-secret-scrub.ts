/**
 * 8gent Code - /go Goal Text Secret Scrub (issue #2609, epic #2605)
 *
 * Scans /go goal text and /subgoal payloads for credential-shaped strings
 * BEFORE the agent loop starts. If anything matches, the /go invocation is
 * rejected with the list of pattern ids (no values logged - the patterns
 * themselves are returned, never the matched substring).
 *
 * Owner: 8SO.
 */

export interface SecretPattern {
	/** Stable id for audit log */
	id: string;
	/** Human-readable label */
	label: string;
	/** Regex - must use the `g` flag so we can collect every hit */
	regex: RegExp;
}

/**
 * Regex pack. Each pattern uses the global flag so a single scrub pass can
 * collect every match and mask them all at once. Patterns are deliberately
 * permissive on the high-entropy side - false-positives are cheaper than
 * letting a key into the cloud-failover prompt.
 */
export const SECRET_PATTERNS: SecretPattern[] = [
	{
		id: "openai-key",
		label: "OpenAI-style API key (sk-...)",
		regex: /sk-[A-Za-z0-9]{20,}/g,
	},
	{
		id: "github-pat",
		label: "GitHub personal access token (ghp_...)",
		regex: /ghp_[A-Za-z0-9]{20,}/g,
	},
	{
		id: "aws-access-key",
		label: "AWS access key id (AKIA...)",
		regex: /AKIA[0-9A-Z]{16}/g,
	},
	{
		id: "jwt",
		label: "JSON Web Token (three base64-url segments)",
		regex: /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
	},
	{
		id: "password-kv",
		label: "Inline password=... assignment",
		regex: /password\s*=\s*['"]?[^\s'"&]{4,}/gi,
	},
	{
		id: "api-key-kv",
		label: "Inline api_key=... / apikey=... / api-key=... assignment",
		regex: /api[_-]?key\s*=\s*['"]?[^\s'"&]{4,}/gi,
	},
];

export interface ScrubResult {
	/** Input with matched substrings replaced by [REDACTED:<id>] */
	clean: string;
	/** Pattern ids that matched at least once (deduplicated, sorted) */
	foundSecrets: string[];
}

/**
 * Scrub goal text. Always returns a clean string suitable for logging; the
 * `foundSecrets` array signals whether the caller should reject the goal.
 *
 * The implementation runs every pattern independently against the original
 * input so overlapping matches are all reported, then applies replacements
 * in a single pass on the input.
 */
export function scrubGoalText(input: string): ScrubResult {
	if (typeof input !== "string" || input.length === 0) {
		return { clean: input ?? "", foundSecrets: [] };
	}

	const hits = new Set<string>();
	let clean = input;

	for (const pat of SECRET_PATTERNS) {
		// Reset lastIndex - regexes have the `g` flag and are module-scoped
		pat.regex.lastIndex = 0;
		const matches = input.match(pat.regex);
		if (matches && matches.length > 0) {
			hits.add(pat.id);
			// Replace on the running `clean` string. Use a fresh regex per
			// replace to avoid cross-pattern lastIndex pollution.
			const replacer = new RegExp(pat.regex.source, pat.regex.flags);
			clean = clean.replace(replacer, `[REDACTED:${pat.id}]`);
		}
	}

	return {
		clean,
		foundSecrets: Array.from(hits).sort(),
	};
}

/**
 * Convenience: returns true if scrubGoalText would find any secret.
 */
export function containsSecret(input: string): boolean {
	return scrubGoalText(input).foundSecrets.length > 0;
}
