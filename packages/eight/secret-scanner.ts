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
 * Issues: 8gi-foundation/8gent-code#2464, #3203.
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

// Value-shape rules. Each pattern is anchored with \b or explicit
// prefix/suffix guards so casual mentions in prose do not trigger. Rules run
// in order and a later rule never sees text an earlier one already replaced,
// so specific shapes (sk-ant-, sk-or-v1-) sit before generic ones (sk-).
const RULES: Rule[] = [
	// PEM private key block, any flavour (RSA, EC, OPENSSH, ENCRYPTED, PGP).
	// An unterminated block (truncated output) is redacted to end of input.
	{
		id: "private_key_block",
		pattern:
			/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
	},

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
		pattern: /\b(AIza[\w-]{35})(?![\w-])/g,
	},

	// Anthropic API key (api03 generation): sk-ant-api03- + 93 body + AA suffix.
	{
		id: "anthropic_api_key",
		pattern: /\b(sk-ant-api03-[A-Za-z0-9_\-]{93}AA)\b/g,
	},

	// OpenRouter: sk-or-v1- + 64 hex.
	{
		id: "openrouter_api_key",
		pattern: /\bsk-or-v1-[a-f0-9]{64}\b/g,
	},

	// OpenAI legacy key: sk- + >=20 chars + T3BlbkFJ marker + >=20 chars.
	{
		id: "openai_api_key",
		pattern: /\bsk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}\b/g,
	},

	// OpenAI project / service-account / admin keys.
	{
		id: "openai_api_key",
		pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_\-]{20,}/g,
	},

	// Generic sk- key (OpenAI-compatible providers, DeepSeek, etc.). Must
	// contain a digit so hyphenated words like CSS class names stay intact.
	{
		id: "sk_api_key",
		pattern: /\bsk-(?=[A-Za-z0-9_\-]*\d)[A-Za-z0-9_\-]{20,}/g,
	},

	// Stripe secret and restricted keys (live and test).
	{
		id: "stripe_key",
		pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
	},

	// DigitalOcean PAT: dop_v1_ + 64 hex.
	{
		id: "digitalocean_pat",
		pattern: /\b(dop_v1_[a-f0-9]{64})\b/g,
	},

	// GitHub tokens: ghp_ (classic PAT), gho_ (OAuth), ghu_ (user-to-server),
	// ghs_ (server-to-server), ghr_ (refresh) + 36 alphanumeric.
	{
		id: "github_token",
		pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
	},

	// GitHub fine-grained PAT: github_pat_ + 82 chars.
	{
		id: "github_token",
		pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,
	},

	// Slack tokens: xoxa- / xoxb- / xoxp- / xoxr- / xoxs- + 10..72 chars.
	{
		id: "slack_token",
		pattern: /\bxox[abprs]-[0-9A-Za-z\-]{10,72}\b/g,
	},

	// Telegram bot token: numeric bot id + ":" + 35 chars.
	{
		id: "telegram_bot_token",
		pattern: /(?<![\w])\d{8,10}:[A-Za-z0-9_\-]{35}(?![\w\-])/g,
	},

	// JWT: three base64url segments, header and payload both start eyJ ("{").
	{
		id: "jwt",
		pattern: /\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g,
	},
];

// Password in URL userinfo: scheme://user:pass@host. Keeps scheme, user and
// host so the line still says which service it points at.
const URL_PASSWORD = /\b([a-z][a-z0-9+.\-]*:\/\/)([^\s:\/@]+):([^\s@\/]+)@/gi;

// AWS secret access key: 40 chars of base64. Too generic to match alone
// (it would hit git SHAs and other ids), so it fires only (a) after an
// aws-named assignment or (b) anywhere in text that also held an AWS key id.
const AWS_SECRET_CONTEXT =
	/(aws[\w\-]*["']?[ \t]*[:=][ \t]*["']?)([A-Za-z0-9\/+]{40})(?![A-Za-z0-9\/+=])/gi;
const AWS_SECRET_BARE = /(?<![A-Za-z0-9\/+])([A-Za-z0-9\/+]{40})(?![A-Za-z0-9\/+=])/g;

function looksLikeAwsSecret(v: string): boolean {
	// Real secrets mix cases and digits. A git SHA is lowercase hex only.
	return /[A-Z]/.test(v) && /[a-z]/.test(v) && /[0-9\/+]/.test(v);
}

// Name-based rule: KEY=value, KEY: value, "key": "value" where the name has a
// secret-like segment. Segments split on _ - . and camelCase, so
// OPENAI_API_KEY, stripe-secret, db.password and apiKey all qualify, while
// AUTHOR, MONKEY and max_tokens do not. The name is kept; the value goes.
const ASSIGNMENT =
	/(?<![A-Za-z0-9_.])(["']?)([A-Za-z_][A-Za-z0-9_.\-]*)\1([ \t]*)(=(?![=>~])|:(?![:=\/]))([ \t]*)(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'`]+))/g;
const ASSIGNMENT_PREFILTER = /key|secret|token|pass|pwd|credential|auth|private/i;

const PASSWORD_WORDS = new Set(["password", "passwd", "pwd", "secret", "passphrase"]);
const SECRET_WORDS = new Set([
	...PASSWORD_WORDS,
	"key",
	"token",
	"credential",
	"credentials",
	"auth",
	"private",
	"apikey",
	"accesskey",
	"secretkey",
	"privatekey",
	"authtoken",
	"accesstoken",
	"refreshtoken",
]);

/** Returns the matched secret word for a variable name, or null. */
function secretWord(name: string): string | null {
	const parts = name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.split(/[_.\-]+/);
	for (const p of parts) if (SECRET_WORDS.has(p)) return p;
	return null;
}

// Values that are references or placeholders, not secrets.
const PLACEHOLDER =
	/^(?:\$\{?[A-Za-z_]\w*\}?|\$\(.*\)|<[^>]*>|\{\{.*\}\}|\*+|x+|true|false|null|none|nil|undefined|yes|no)$/i;
const TEMPLATE_VALUE = /^(?:(?:your|my)[_\-][\w\-]*|changeme|change[_\-]me|replace[_\-]me|placeholder)$/i;
const DOTTED_IDENT = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/; // process.env.X, config.token
const FILE_PATH = /^(?:~|\.{1,2})?\/[\w.\/\-]*$/;

function isNonSecretValue(value: string, word: string, sep: string): boolean {
	if (value.length === 0) return true;
	if (value.includes("[REDACTED:")) return true;
	if (PLACEHOLDER.test(value) || TEMPLATE_VALUE.test(value) || DOTTED_IDENT.test(value) || FILE_PATH.test(value)) return true;
	if (PASSWORD_WORDS.has(word)) return false; // any real value after password= goes
	if (/^\d+(?:\.\d+)?$/.test(value)) return true; // sort_key=1, auth=0
	// Short plain words: "sort_key=asc", "token: string", "auth: see below".
	if (/^[A-Za-z]+$/.test(value) && value.length < 16) return true;
	if (sep === ":" && /^[a-z][\w\-]*$/.test(value) && value.length < 16) return true;
	return false;
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
	const fire = (id: string) => {
		count++;
		firedRules.add(id);
	};

	for (const rule of RULES) {
		const replacement = `[REDACTED:${rule.id}]`;
		rule.pattern.lastIndex = 0;
		out = out.replace(rule.pattern, () => {
			fire(rule.id);
			return replacement;
		});
	}

	out = out.replace(URL_PASSWORD, (match, scheme: string, user: string, pass: string) => {
		if (pass.startsWith("[REDACTED:") || PLACEHOLDER.test(pass)) return match;
		fire("url_password");
		return `${scheme}${user}:[REDACTED:url_password]@`;
	});

	out = out.replace(AWS_SECRET_CONTEXT, (match, prefix: string, value: string) => {
		if (!looksLikeAwsSecret(value)) return match;
		fire("aws_secret_key");
		return `${prefix}[REDACTED:aws_secret_key]`;
	});
	if (firedRules.has("aws_access_key")) {
		out = out.replace(AWS_SECRET_BARE, (match, value: string) => {
			if (!looksLikeAwsSecret(value)) return match;
			fire("aws_secret_key");
			return "[REDACTED:aws_secret_key]";
		});
	}

	// Name-based pass runs last so values already replaced above are skipped.
	if (ASSIGNMENT_PREFILTER.test(out)) {
		out = out.replace(
			ASSIGNMENT,
			(
				match,
				quote: string,
				name: string,
				pre: string,
				sep: string,
				post: string,
				dq: string | undefined,
				sq: string | undefined,
				bare: string | undefined,
			) => {
				const word = secretWord(name);
				if (!word) return match;
				let value = dq ?? sq ?? bare ?? "";
				let rest = "";
				if (bare !== undefined && sep === ":" && !PLACEHOLDER.test(bare)) {
					// In "key: value" contexts (YAML, JSON-ish, code) stop at
					// structural punctuation so the next field survives.
					const cut = bare.search(/[,;{}()\[\]]/);
					if (cut >= 0) {
						value = bare.slice(0, cut);
						rest = bare.slice(cut);
					}
				}
				if (isNonSecretValue(value, word, sep)) return match;
				fire("secret_assignment");
				const q = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
				return `${quote}${name}${quote}${pre}${sep}${post}${q}[REDACTED:secret_assignment]${q}${rest}`;
			},
		);
	}

	return {
		scrubbed: out,
		redactedCount: count,
		rules: [...firedRules].sort(),
	};
}
