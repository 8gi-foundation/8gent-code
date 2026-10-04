/**
 * Secret Redaction — strip API keys, tokens, and credentials before storing
 * content in memory. Run on all input to learn()/remember().
 */

const PATTERNS: Array<[RegExp, string]> = [
	// AWS keys
	[/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_KEY]"],
	// AWS secret keys
	[
		/(?<=(?:secret|aws)[_\s-]?(?:access)?[_\s-]?key['":\s=]+)[A-Za-z0-9/+=]{40}/gi,
		"[REDACTED_AWS_SECRET]",
	],
	// GitHub tokens (classic + fine-grained)
	[/gh[ps]_[A-Za-z0-9_]{36,255}/g, "[REDACTED_GITHUB_TOKEN]"],
	[/github_pat_[A-Za-z0-9_]{22,255}/g, "[REDACTED_GITHUB_PAT]"],
	// Generic API keys (key=... or key: ...)
	[/(?<=(?:api[_-]?key|apikey|token|secret)['":\s=]+)[A-Za-z0-9\-_.]{20,}/gi, "[REDACTED_API_KEY]"],
	// JWTs (three base64url segments separated by dots)
	[/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"],
	// PEM private keys
	[
		/-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
		"[REDACTED_PEM_KEY]",
	],
	// Slack tokens
	[/xox[bpors]-[0-9]{10,}-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK_TOKEN]"],
	// Anthropic keys (before the OpenAI rule, which would also match them)
	[/sk-ant-[A-Za-z0-9\-_]{20,}/g, "[REDACTED_ANTHROPIC_KEY]"],
	// OpenAI keys: classic sk-..., and sk-proj-, sk-svcacct-, sk-admin- (hyphens and
	// underscores inside). Not after a letter or digit, so prose like "risk-..." is left.
	[/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED_OPENAI_KEY]"],
	// Stripe secret and restricted keys, live and test
	[/(?<![A-Za-z0-9_])[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, "[REDACTED_STRIPE_KEY]"],
	// Bearer tokens (an HTTP Authorization header pasted into text)
	[/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[REDACTED_BEARER_TOKEN]"],
	// Credentials inside a URL: scheme://user:pass@host keeps scheme and host
	[/(?<=:\/\/)[^\s/:@]{1,256}:[^\s/@]{1,256}(?=@)/g, "[REDACTED_URL_CREDENTIALS]"],
];

/**
 * Redact known secret patterns from content.
 * Returns the content with secrets replaced by placeholder labels.
 */
export function redact(content: string): string {
	let result = content;
	for (const [pattern, replacement] of PATTERNS) {
		result = result.replace(pattern, replacement);
	}
	return result;
}
