/**
 * Secret scanner for tool output.
 *
 * Deterministic regex-based scrubbing of provider secrets so they never
 * reach the model context, session checkpoints, JSONL logs, or the
 * Telegram bridge. Pure function. No I/O. No external deps.
 *
 * Patterns sourced clean-room from public secret-format documentation
 * (provider docs + GitHub secret-scanning partner specs).
 *
 * Issue: 8gi-foundation/8gent-code#2464.
 */

export interface ScrubResult {
	scrubbed: string;
	redactedCount: number;
	rules: string[];
}

interface Rule {
	id: string;
	pattern: RegExp;
}

// Static rule table. Each pattern is anchored with \b or explicit prefix/suffix
// guards so casual mentions in prose do not trigger. Order is irrelevant —
// every rule runs independently.
const RULES: Rule[] = [
	// AWS access key id: 4-char prefix (AKIA / ASIA / ABIA / ACCA / A3T*) +
	// 16 chars from base32 alphabet. Public ref: AWS docs on access-key
	// format + GitHub secret-scanning partner spec.
	{
		id: "aws_access_key",
		pattern: /\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b/g,
	},

	// GCP API key: AIza + 35 chars [A-Za-z0-9_-].
	{
		id: "gcp_api_key",
		pattern: /\b(AIza[\w-]{35})\b/g,
	},

	// Anthropic API key (api03 generation): sk-ant-api03- + 93 body + AA suffix.
	{
		id: "anthropic_api_key",
		pattern: /\b(sk-ant-api03-[A-Za-z0-9_\-]{93}AA)\b/g,
	},

	// OpenAI API key: sk- + >=20 chars + T3BlbkFJ marker + >=20 chars.
	{
		id: "openai_api_key",
		pattern: /\bsk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}\b/g,
	},

	// DigitalOcean PAT: dop_v1_ + 64 hex.
	{
		id: "digitalocean_pat",
		pattern: /\b(dop_v1_[a-f0-9]{64})\b/g,
	},

	// GitHub classic PAT: ghp_ + 36 alphanumeric.
	{
		id: "github_token",
		pattern: /\bghp_[A-Za-z0-9]{36}\b/g,
	},

	// GitHub fine-grained PAT: github_pat_ + 82 chars.
	{
		id: "github_token",
		pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,
	},

	// Slack bot/user token: xoxb- or xoxp- + 10..72 chars.
	{
		id: "slack_token",
		pattern: /\bxox[bp]-[0-9A-Za-z\-]{10,72}\b/g,
	},
];

// Bonus rule: high-entropy values adjacent to a secret-like keyword.
// Best-effort. Triggers only when (a) keyword is present and (b) the
// candidate clears an entropy threshold and length bar. Designed so
// "api_key=hello_world_..." does NOT fire.
const KEYWORD_PREFIX = /\b(api[_-]?key|secret|token|password|passwd|pwd|auth)\s*[:=]\s*([^\s"',;]+)/gi;
const ENTROPY_MIN_LENGTH = 24;
const ENTROPY_THRESHOLD = 4.0; // Shannon entropy bits/char.
const MIN_CHAR_CLASSES = 3; // From {digit, upper, lower, symbol}. Real keys hit 4; prose words hit 1-2.

function shannonEntropy(s: string): number {
	const counts = new Map<string, number>();
	for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	const len = s.length;
	let h = 0;
	for (const c of counts.values()) {
		const p = c / len;
		h -= p * Math.log2(p);
	}
	return h;
}

function charClassCount(s: string): number {
	let n = 0;
	if (/\d/.test(s)) n++;
	if (/[A-Z]/.test(s)) n++;
	if (/[a-z]/.test(s)) n++;
	if (/[^A-Za-z0-9]/.test(s)) n++;
	return n;
}

/**
 * Scrub provider secrets from `text`. Returns the redacted text, a count
 * of replacements, and the unique set of rule ids that fired.
 *
 * Replacement format: `[REDACTED:<rule-id>]`. Length is not preserved
 * exactly but stays close enough that line-oriented output (grep, etc.)
 * remains readable.
 */
export function scrub(text: string): ScrubResult {
	if (!text) return { scrubbed: text ?? "", redactedCount: 0, rules: [] };

	let out = text;
	let count = 0;
	const firedRules = new Set<string>();

	for (const rule of RULES) {
		const replacement = `[REDACTED:${rule.id}]`;
		// Reset lastIndex defensively; pattern is /g.
		rule.pattern.lastIndex = 0;
		out = out.replace(rule.pattern, () => {
			count++;
			firedRules.add(rule.id);
			return replacement;
		});
	}

	// High-entropy keyword pass. Done last so it does not double-redact
	// values already replaced by the structured rules above.
	out = out.replace(KEYWORD_PREFIX, (match, keyword: string, value: string) => {
		if (value.startsWith("[REDACTED:")) return match;
		if (value.length < ENTROPY_MIN_LENGTH) return match;
		if (charClassCount(value) < MIN_CHAR_CLASSES) return match;
		if (shannonEntropy(value) < ENTROPY_THRESHOLD) return match;
		count++;
		firedRules.add("entropy_keyword");
		// Preserve the keyword + separator so context is not lost.
		const sepMatch = match.match(/[:=]\s*/);
		const sep = sepMatch ? sepMatch[0] : "=";
		return `${keyword}${sep}[REDACTED:entropy_keyword]`;
	});

	return {
		scrubbed: out,
		redactedCount: count,
		rules: [...firedRules].sort(),
	};
}
