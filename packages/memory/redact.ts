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
	// GitHub tokens: personal (ghp_), OAuth (gho_), user-to-server (ghu_),
	// server-to-server (ghs_) and refresh (ghr_), plus fine-grained PATs
	[/gh[pousr]_[A-Za-z0-9_]{36,255}/g, "[REDACTED_GITHUB_TOKEN]"],
	[/github_pat_[A-Za-z0-9_]{22,255}/g, "[REDACTED_GITHUB_PAT]"],
	// Google API keys: "AIza" then 35 url-safe characters
	[/AIza[0-9A-Za-z_-]{35}/g, "[REDACTED_GOOGLE_API_KEY]"],
	// Hugging Face user access tokens: "hf_" then 34 letters or digits, standing alone
	[/(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{34}(?![A-Za-z0-9_])/g, "[REDACTED_HF_TOKEN]"],
	// GitLab personal access tokens: "glpat-" then 20 or more url-safe characters,
	// with the optional ".<version>.<id>" tail of the newer routable form
	[/glpat-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*/g, "[REDACTED_GITLAB_TOKEN]"],
	// npm access tokens: "npm_" then 36 letters or digits (npm_config_* names have underscores)
	[/(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9_])/g, "[REDACTED_NPM_TOKEN]"],
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
	// OpenAI keys. The named prefixes and the classic form (20+ letters or digits right
	// after "sk-") match anywhere, even glued to the text before them. Any other
	// hyphenated sk- form must start a word, so prose like "risk-assessment-..." is left.
	[/sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g, "[REDACTED_OPENAI_KEY]"],
	[/sk-[A-Za-z0-9]{20,}[A-Za-z0-9_-]*/g, "[REDACTED_OPENAI_KEY]"],
	[/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED_OPENAI_KEY]"],
	// Stripe secret and restricted keys, live and test
	[/(?<![A-Za-z0-9_])[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, "[REDACTED_STRIPE_KEY]"],
	// Bearer tokens (an HTTP Authorization header pasted into text)
	[/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[REDACTED_BEARER_TOKEN]"],
	// Telegram bot tokens: <bot id>:<35-ish url-safe chars>, also inside a /bot<token>/ URL.
	// The id run is anchored and capped (6 to 12 digits) so a long digit run with no colon
	// is scanned once, not once per start position (#248).
	[/(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,}/g, "[REDACTED_BOT_TOKEN]"],
	// .env style lines: a secret-like name (KEY, TOKEN, SECRET, PASSWORD...) with a value
	[
		/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Za-z0-9_]*)(\s*[=:]\s*)(?!\[REDACTED)[^\s'"]+/g,
		"$1$2[REDACTED_SECRET]",
	],
	// password= and password: in any case (the rule above is upper case only, so
	// "monkey: x" or "author: y" are not touched). The name must end in pass(word|wd),
	// so "passwordless: true" and prose like "the password field" are left alone.
	// A quoted JSON key ("password":) is matched too, and a quoted value is redacted
	// up to its closing quote, so "correct horse battery" does not leak its tail.
	[
		/\b([A-Za-z0-9_]*pass(?:word|wd))(["']?\s*[=:]\s*)(["']?)(?!\[REDACTED)(?:(?<=")[^"\n]+|(?<=')[^'\n]+|[^\s'"]+)/gi,
		"$1$2$3[REDACTED_SECRET]",
	],
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
