/**
 * 8gent Code - Secret detector for file writes.
 *
 * Backs the `has_secret` policy operator used by the `no-secrets-in-files`
 * rule in default-policies.yaml.
 *
 * Why this exists: the rule used to be a case-insensitive substring match on
 * the words API_KEY / SECRET / PASSWORD / TOKEN / PRIVATE_KEY. Prose tripped
 * it. A Markdown slide outline was blocked because it said "secret-to-network"
 * and "answer-token mapping". Any README, design doc or deck that talks about
 * auth could not be written.
 *
 * This module looks for credential SHAPES instead of credential WORDS:
 *   - vendor key formats (AWS, GitHub, sk-..., Stripe, Slack, JWT),
 *   - PEM private key blocks with a body,
 *   - credentials embedded in a URL,
 *   - a secret-named variable assigned a value that looks random.
 *
 * Every pattern is linear or bounded, so a large write cannot stall the gate.
 * The detector reports pattern ids only, never the matched value.
 */

interface ShapePattern {
	id: string;
	/** Must carry the `g` flag: every match is checked against `allow`. */
	regex: RegExp;
	/** Documented example values that are safe to write. */
	allow?: (match: string) => boolean;
}

/** Credential formats that are unambiguous on their own. */
const SHAPE_PATTERNS: ShapePattern[] = [
	// AWS's own documentation key (AKIAIOSFODNN7EXAMPLE) ends in EXAMPLE.
	{
		id: "aws-access-key-id",
		regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
		allow: (m) => m.endsWith("EXAMPLE"),
	},
	{ id: "github-token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
	{ id: "github-fine-grained-pat", regex: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
	// sk-..., sk-proj-..., sk-ant-api03-... The tail must contain a digit so
	// hyphenated prose ("sk-learn-compatible-wrapper") never matches.
	{ id: "sk-api-key", regex: /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g },
	{ id: "stripe-key", regex: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
	{ id: "slack-token", regex: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g },
	{ id: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
	// A header on its own is documentation. A header followed by key material
	// (optionally after Proc-Type / DEK-Info lines) is a key.
	{
		id: "pem-private-key",
		regex:
			/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----\s*(?:[A-Za-z-]{1,40}:[^\n]{0,200}\n\s*){0,4}[A-Za-z0-9+/=]{40,}/g,
	},
];

/** scheme://user:password@host - password must not be an obvious placeholder. */
const URL_CREDENTIAL = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"]{1,64}:([^\s@/'"]{1,128})@/gi;

/**
 * name = value, name: value, "name": "value", export NAME="value".
 * The name is captured bounded ({0,63}) so a long identifier run cannot
 * backtrack quadratically. Whether the name is secret-ish is decided in code.
 */
const ASSIGNMENT =
	/([A-Za-z_][A-Za-z0-9_.-]{0,63})["']?[ \t]*(?::|=)(?!=)[ \t]*(["'`]?)([^\s"'`,;&()}\]]{1,512})/g;

/** Identifier ends with a credential noun. "max_tokens" and "TOKEN_TYPE" do not. */
const SECRET_NAME =
	/(?:api[_-]?key|apikey|secret|secret[_-]?key|token|passw(?:or)?d|pwd|private[_-]?key|access[_-]?key|credentials?|auth[_-]?key)$/i;

const PLACEHOLDER =
	/^(?:x+|\*+|\.+|<.*>|\{.*\}|\$\{.*\}|\$[A-Za-z_]\w*|%.*%|changeme|change[_-]?me|example|placeholder|redacted|dummy|test|none|null|undefined|true|false|password|secret|token|your[_-].*|.*[_-]here)$/i;

const ENV_REFERENCE =
	/^(?:process\.env|import\.meta\.env|os\.environ|os\.getenv|env\.|Deno\.env|Bun\.env)/;

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
	const counts = new Map<string, number>();
	for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let h = 0;
	for (const n of counts.values()) {
		const p = n / s.length;
		h -= p * Math.log2(p);
	}
	return h;
}

function charClasses(s: string): number {
	let n = 0;
	if (/[a-z]/.test(s)) n++;
	if (/[A-Z]/.test(s)) n++;
	if (/[0-9]/.test(s)) n++;
	if (/[^A-Za-z0-9]/.test(s)) n++;
	return n;
}

/**
 * Does this assigned value look like a real credential rather than prose,
 * a type name, a placeholder, or a reference to the environment?
 */
function looksLikeSecretValue(value: string, quoted: boolean): boolean {
	if (value.length < 8) return false;
	if (PLACEHOLDER.test(value)) return false;
	if (ENV_REFERENCE.test(value)) return false;
	// Template / shell interpolation: "${SECRET}", "{{ token }}", "%(pw)s".
	if (/^(?:\$\{|\{\{|%\()/.test(value)) return false;
	// UPPER_SNAKE values are identifiers (YOUR_API_KEY, MY_TOKEN_VAR).
	if (/^[A-Z0-9_]+$/.test(value) && value.includes("_")) return false;
	// Plain words joined by - or _ ("lm-studio", "test-token", "AccessTokenType").
	if (/^[A-Za-z]+(?:[-_][A-Za-z]+)*$/.test(value)) return false;
	// Paths, URLs without credentials, regex literals.
	if (value.startsWith("/")) return false;
	if (!quoted) {
		// Code, not a literal: "token = header.slice(7)", "apiKey = opts.key2".
		if (/^[A-Za-z_$][\w$]*(?:\.[\w$]+)+$/.test(value) || value.endsWith("[")) return false;
		// Unquoted values must mix letters and digits.
		if (!(/[A-Za-z]/.test(value) && /[0-9]/.test(value))) return false;
	}
	if (charClasses(value) < 2) return false;
	// Real keys and passwords carry a digit; long mixed values may not.
	if (!/[0-9]/.test(value) && !(value.length >= 20 && charClasses(value) >= 3)) return false;
	const minEntropy = value.length >= 16 ? 3.0 : 2.5;
	return entropy(value) >= minEntropy;
}

/**
 * Scan content for credential shapes. Returns the ids of the patterns that
 * matched (deduplicated, sorted). Empty array means no secret found.
 */
export function detectSecrets(content: string): string[] {
	if (typeof content !== "string" || content.length === 0) return [];
	const hits = new Set<string>();

	for (const { id, regex, allow } of SHAPE_PATTERNS) {
		regex.lastIndex = 0;
		for (const m of content.matchAll(regex)) {
			if (allow?.(m[0])) continue;
			hits.add(id);
			break;
		}
	}

	URL_CREDENTIAL.lastIndex = 0;
	for (const m of content.matchAll(URL_CREDENTIAL)) {
		const password = m[1];
		if (!PLACEHOLDER.test(password) && !/^pass(?:word)?$/i.test(password)) {
			hits.add("url-credentials");
			break;
		}
	}

	ASSIGNMENT.lastIndex = 0;
	for (const m of content.matchAll(ASSIGNMENT)) {
		const [, name, quote, value] = m;
		if (!SECRET_NAME.test(name)) continue;
		if (looksLikeSecretValue(value, quote !== "")) {
			hits.add("secret-assignment");
			break;
		}
	}

	return Array.from(hits).sort();
}

/** Convenience: true if detectSecrets finds anything. */
export function hasSecret(content: string): boolean {
	return detectSecrets(content).length > 0;
}
