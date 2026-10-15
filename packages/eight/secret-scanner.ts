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
 * Passes, in order:
 *   1. Input cap: only the first MAX_SCAN_CHARS are scanned. The rest is
 *      dropped and replaced by one [REDACTED:input_cap] marker (fail closed).
 *   2. Value shapes (provider key formats, PEM blocks, JWTs).
 *   3. URL userinfo (scheme://user:pass@host and scheme://token@host).
 *   4. HTTP headers (Authorization, Proxy-Authorization, Cookie, Set-Cookie)
 *      and bare "Bearer <token>".
 *   5. CLI forms (--password V, curl -u, sshpass -p, mysql -pV).
 *   6. AWS secret access keys (see the limit below).
 *   7. Secret-named assignments (KEY=V, key: V, "key": "V", YAML blocks).
 *
 * Every regex has bounded quantifiers or a fixed shape so a hostile 1 MB
 * input cannot cause catastrophic backtracking.
 *
 * Short values are a deliberate trade (8SO ruling on #4018): key, token and
 * auth names redact only values of 16+ chars or with a letter/digit mix, so
 * TOKEN=123456 or sort_key=asc stay readable. Password, passwd, pwd, secret
 * and private names always redact any non-placeholder value.
 *
 * Values longer than MAX_VALUE are redacted to the end of the token, never
 * cut with the tail left in the clear.
 *
 * Known limit, AWS secret access keys: a secret key is 40 chars of base64
 * with no prefix, so it cannot be told apart from other 40-char tokens.
 * It is caught only (a) after an aws-named assignment, (b) after any
 * secret-named assignment, or (c) anywhere in a text that also contains an
 * AWS access key id. In case (c) any other 40-char mixed-case base64 token
 * in the same text is redacted too, which is accepted noise. A bare secret
 * key with no name and no key id nearby is NOT caught.
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
	/** Optional extra check on the matched text. */
	accept?: (match: string) => boolean;
}

/** Characters scanned. Anything past this is replaced, never passed through. */
export const MAX_SCAN_CHARS = 2 * 1024 * 1024;

// Value-shape rules. Specific shapes (sk-ant-, sk-or-v1-) sit before generic
// ones (sk-), and a later rule never sees text an earlier one replaced.
const RULES: Rule[] = [
	// PEM private key block, any flavour. Unterminated (truncated output) is
	// redacted to end of input. Public keys and certificates are left alone.
	{
		id: "private_key_block",
		pattern:
			/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g,
	},
	{
		id: "aws_access_key",
		pattern: /\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b/g,
	},
	{ id: "gcp_api_key", pattern: /\b(AIza[\w-]{35})(?![\w-])/g },
	{ id: "google_oauth_token", pattern: /\bya29\.[A-Za-z0-9_\-]{20,2048}/g },
	{ id: "google_oauth_secret", pattern: /\bGOCSPX-[A-Za-z0-9_\-]{24,64}/g },
	{ id: "anthropic_api_key", pattern: /\b(sk-ant-api03-[A-Za-z0-9_\-]{93}AA)\b/g },
	{ id: "openrouter_api_key", pattern: /\bsk-or-v1-[a-f0-9]{64}\b/g },
	{ id: "openai_api_key", pattern: /\bsk-[A-Za-z0-9]{20,256}T3BlbkFJ[A-Za-z0-9]{20,256}\b/g },
	{ id: "openai_api_key", pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_\-]{20,512}/g },
	// Generic sk- key. Must contain a digit and either be 24+ alphanumerics
	// or 32+ chars with at most 2 hyphens, so CSS class names pass.
	{
		id: "sk_api_key",
		pattern: /\bsk-[A-Za-z0-9_\-]{24,512}/g,
		accept: (m) => {
			const body = m.slice(3);
			if (!/\d/.test(body)) return false;
			if (/^[A-Za-z0-9]+$/.test(body)) return true;
			return body.length >= 32 && (body.match(/-/g)?.length ?? 0) <= 2;
		},
	},
	{ id: "stripe_key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,256}\b/g },
	{ id: "digitalocean_pat", pattern: /\b(dop_v1_[a-f0-9]{64})\b/g },
	{ id: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
	{ id: "github_token", pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
	{ id: "slack_token", pattern: /\bxox[abprs]-[0-9A-Za-z\-]{10,72}\b/g },
	{
		id: "slack_webhook",
		pattern:
			/https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]{6,32}\/B[A-Za-z0-9_]{6,32}\/[A-Za-z0-9_]{16,64}/g,
	},
	{ id: "npm_token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
	{ id: "huggingface_token", pattern: /\bhf_[A-Za-z0-9]{30,64}\b/g },
	{ id: "groq_api_key", pattern: /\bgsk_[A-Za-z0-9]{48,64}\b/g },
	{ id: "xai_api_key", pattern: /\bxai-[A-Za-z0-9]{70,100}\b/g },
	{ id: "sendgrid_api_key", pattern: /\bSG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}(?![\w-])/g },
	{ id: "twilio_api_key", pattern: /\bSK[0-9a-fA-F]{32}\b/g },
	{
		id: "discord_token",
		pattern: /\b[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}\b/g,
	},
	{ id: "telegram_bot_token", pattern: /(?<![\w])\d{8,10}:[A-Za-z0-9_\-]{35}(?![\w\-])/g },
	{
		id: "jwt",
		pattern: /\beyJ[A-Za-z0-9_\-]{8,4096}\.eyJ[A-Za-z0-9_\-]{8,8192}\.[A-Za-z0-9_\-]{8,4096}/g,
	},
	// Azure SAS signature in a query string.
	{ id: "azure_sas", pattern: /(?<=[?&]sig=)[A-Za-z0-9%+\/=]{16,256}/g },
];

// scheme://[user]:pass@host. Password is greedy to the LAST @ before the host,
// so a password containing @ or / is covered.
const URL_PASSWORD =
	/\b([a-z][a-z0-9+.\-]{0,31}:\/\/)([^\s:\/@"'`]{0,256}):([^\s"'`]{1,512})@(?=[^\s@\/"'`]{1,253}(?:[\/\s"'`?#]|$))/gi;
// scheme://token@host (no colon). Fires only on token-shaped userinfo.
const URL_TOKEN =
	/\b([a-z][a-z0-9+.\-]{0,31}:\/\/)([^\s:\/@"'`]{8,256})@(?=[^\s@\/"'`]{1,253}(?:[\/\s:"'`?#]|$))/gi;

const AUTH_HEADER =
	/(?<![\w-])((?:proxy-)?authorization[ \t]{0,16}:[ \t]{0,16})(?:(bearer|basic|token|digest|negotiate|ntlm)([ \t]{1,16}))?([^\r\n]{1,4096})/gi;
const COOKIE_HEADER =
	/(?<![\w-])(set-cookie|cookie)([ \t]{0,16}:[ \t]{0,16})([^\r\n"'`]{1,8192})/gi;
const BEARER = /\b(Bearer[ \t]{1,16})([A-Za-z0-9._~+\/\-]{16,4096}=*)/g;

const CURL_USER =
	/(\bcurl\b[^\n]{0,512}?[ \t](?:-u|--user)(?:[ \t]{1,16}|=)?)(["']?)([^\s:"']{0,128}):([^\s"']{1,512})\2/g;
const SSHPASS =
	/(\bsshpass\b[^\n]{0,64}?[ \t]-p[ \t]{0,16})(?:'([^'\n]{1,512})'|"([^"\n]{1,512})"|([^\s'"]{1,512}))/g;
const MYSQL_P =
	/(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n]{0,256}?[ \t]-p)(?:'([^'\n]{1,512})'|"([^"\n]{1,512})"|([^\s'"\-][^\s'"]{0,511}))/g;
const LONG_FLAG = /(?<![\w-])--([A-Za-z][A-Za-z0-9_\-]{0,63})(=|[ \t]{1,16})/g;

const AWS_SECRET_CONTEXT =
	/(aws[\w\-]{0,64}["']?[ \t]{0,16}[:=][ \t]{0,16}["']?)([A-Za-z0-9\/+]{40})(?![A-Za-z0-9\/+=])/gi;
const AWS_SECRET_BARE = /(?<![A-Za-z0-9\/+])([A-Za-z0-9\/+]{40})(?![A-Za-z0-9\/+=])/g;

// Name + separator only; the value is parsed by hand so non-secret names never
// consume text. Lookbehind excludes - . and word chars so a long run like
// "a-a-a-" or "key.key." starts at most one attempt per run (no ReDoS).
const NAME_SEP =
	/(?<![A-Za-z0-9_.\-$])(["']?)([A-Za-z_][A-Za-z0-9_.\-]{0,127})\1([ \t]{0,64})(=(?![=>~])|:(?![:=\/]))/g;
const NAME_PREFILTER = /key|secret|token|pass|pwd|credential|auth|private/i;
const YAML_BLOCK_HEAD = /^[|>][+-]?[0-9]?[ \t]*(?:#.*)?$/;

type Family = "strong" | "weak" | "auth";

const STRONG_WORDS = new Set([
	"password",
	"passwd",
	"pwd",
	"secret",
	"secrets",
	"private",
	"passphrase",
	"secretkey",
	"privatekey",
	"clientsecret",
]);
const WEAK_WORDS = new Set([
	"key",
	"token",
	"credential",
	"credentials",
	"apikey",
	"accesskey",
	"authtoken",
	"accesstoken",
	"refreshtoken",
]);
// A name whose last part is one of these points at a secret, it is not one.
const POINTER_SUFFIX = new Set([
	"url",
	"uri",
	"endpoint",
	"host",
	"path",
	"file",
	"dir",
	"name",
	"type",
	"header",
]);

function family(name: string): Family | null {
	const parts = name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.split(/[_.\-]+/)
		.filter(Boolean);
	if (parts.length === 0) return null;
	if (parts.includes("public") || parts.includes("publishable")) return null;
	if (POINTER_SUFFIX.has(parts[parts.length - 1])) return null;
	if (name === "PWD" || name === "OLDPWD") return null; // shell working directory
	let f: Family | null = null;
	for (const p of parts) {
		if (STRONG_WORDS.has(p)) return "strong";
		if (WEAK_WORDS.has(p)) f = "weak";
		else if (p === "auth" && !f) f = "auth";
	}
	return f;
}

const UPPER_SNAKE = "[A-Z_][A-Z0-9_]*";
const PLACEHOLDER =
	/^(?:\$\(.*\)|\$\{\{.*\}\}|\{\{.*\}\}|\*+|x+|true|false|null|none|nil|undefined|yes|no|on|off)$/i;
// Wrappers count only around UPPER_SNAKE names: ${DB_PASSWORD} yes, ${Zq9x} no.
const WRAPPED_NAME = new RegExp(
	`^(?:\\$${UPPER_SNAKE}|\\$\\{${UPPER_SNAKE}\\}|<${UPPER_SNAKE}>|%${UPPER_SNAKE}%)$`,
);
const TEMPLATE_VALUE = /^(?:your[_\-][\w\-]*|changeme|change[_\-]me|replace[_\-]me|placeholder)$/i;
const ENV_REF =
	/^(?:process\.env|import\.meta\.env|os\.environ|Deno\.env|Bun\.env)\b[\w.$\[\]'"]*[,;]?$/;
const CALL = /^(?:await\s+|new\s+)?[A-Za-z_$][\w$.]*\([^()\n]*\)[\w$.()]*[,;]?$/;
const AWAIT_EXPR = /^await\s+[A-Za-z_$][\w$.]*[,;]?$/;
const TS_TYPE =
	/^(?:string|number|boolean|any|unknown|void|undefined|null|object|bigint|symbol|never)(?:\[\])?(?:\s*\|\s*[\w\[\]]+)*[;,]?$/;
const DOTTED_IDENT = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[,;]?$/;
const FILE_PATH = /^(?:(?:~|\.{1,2})?\/[\w.\/\-]*|[\w.\-]+(?:\/[\w.\-]+)+\.[A-Za-z0-9]{1,6})$/;
const PLAIN_URL = /^[a-z][a-z0-9+.\-]{0,31}:\/\/[^\s@]*$/i;

function isPlaceholder(v: string): boolean {
	return WRAPPED_NAME.test(v) || PLACEHOLDER.test(v) || TEMPLATE_VALUE.test(v);
}

function isCode(v: string): boolean {
	if (/^`[^`]*\$\{[^`]*`[,;]?$/.test(v)) return true; // template literal
	return ENV_REF.test(v) || CALL.test(v) || AWAIT_EXPR.test(v) || TS_TYPE.test(v);
}

function hasLetterDigit(v: string): boolean {
	return /[A-Za-z]/.test(v) && /\d/.test(v);
}

/** True when any . / ? & = : separated segment is 16+ chars with letters and digits. */
function hasKeyLikeSegment(v: string): boolean {
	return v.split(/[.\/?&=:]/).some((seg) => seg.length >= 16 && hasLetterDigit(seg));
}

/** Decide whether a value under a secret name should be redacted. */
function shouldRedact(value: string, fam: Family): boolean {
	const v = value.trim();
	if (v.length === 0) return false;
	if (v.includes("[REDACTED:")) return false;
	if (isPlaceholder(v) || isCode(v)) return false;
	if (fam === "strong") return true; // password, secret, private: any real value
	// Dotted refs, paths and plain URLs are exempt only when no segment looks
	// like a key, so API_KEY=/<secret> and ?k=<secret> still redact.
	if ((DOTTED_IDENT.test(v) || FILE_PATH.test(v)) && !hasKeyLikeSegment(v)) return false;
	if (PLAIN_URL.test(v) && !hasKeyLikeSegment(v.slice(v.indexOf("?") + 1 || v.length)))
		return false;
	// kebab cache keys: build-linux-x64-abc123, node-modules-8f3a9c1e
	if (
		/^[a-z0-9]+(?:-[a-z0-9]+){2,}$/.test(v) &&
		(v.match(/(?:^|-)[a-z]{3,}(?=-|$)/g)?.length ?? 0) >= 2
	)
		return false;
	if (fam === "auth") return v.length >= 16 || (hasLetterDigit(v) && v.length >= 8);
	return v.length >= 16 || hasLetterDigit(v);
}

// Longest value read after a secret name. Bounds every per-match scan so a
// hostile line cannot make the walk quadratic; a longer value is redacted up
// to this length and the remainder is scanned as ordinary text.
const MAX_VALUE = 4096;
// How far back to look for the start of the line (flow-context check).
const MAX_LOOKBACK = 256;

function lineStartBefore(text: string, idx: number): number {
	const from = Math.max(0, idx - MAX_LOOKBACK);
	const nl = text.slice(from, idx).lastIndexOf("\n");
	return nl === -1 ? from : from + nl + 1;
}

interface ValueSpan {
	start: number; // index of first value char (after opening quote)
	end: number; // index after last value char
	resume: number; // where scanning continues
	truncated?: boolean; // ran past MAX_VALUE: always redacted (fail closed)
}

/** Past the scan window, extend to the end of the token so no tail leaks. */
function overrun(text: string, q: number, quote: string | null): number {
	if (quote) while (q < text.length && text[q] !== quote && text[q] !== "\n") q++;
	else while (q < text.length && !/\s/.test(text[q])) q++;
	return q;
}

/**
 * Parse the value that starts at `pos`. Quoted values run to the closing
 * quote (or end of line if unclosed). Unquoted values for strong names run
 * to end of line, except in JSON/YAML flow context where , ; ) ] } end them.
 */
function parseValue(
	text: string,
	pos: number,
	fam: Family,
	sep: string,
	flow: boolean,
	oneToken: boolean,
): ValueSpan | null {
	let p = pos;
	while (p < text.length && (text[p] === " " || text[p] === "\t")) p++;
	// "password":\n  "V" - a JSON value on the next line.
	if (sep === ":" && (text[p] === "\n" || text[p] === "\r")) {
		let q = p;
		if (text[q] === "\r") q++;
		if (text[q] === "\n") q++;
		while (q < text.length && (text[q] === " " || text[q] === "\t") && q - p < 64) q++;
		if (text[q] === '"' || text[q] === "'") p = q;
		else return null;
	}
	const ch = text[p];
	const limit = Math.min(text.length, p + MAX_VALUE);
	if (ch === '"' || ch === "'" || ch === "`") {
		let q = p + 1;
		while (q < limit && text[q] !== ch && text[q] !== "\n") {
			if (text[q] === "\\") q++;
			q++;
		}
		if (q >= limit && limit < text.length) {
			const e = overrun(text, q, ch);
			return { start: p + 1, end: e, resume: text[e] === ch ? e + 1 : e, truncated: true };
		}
		const closed = text[q] === ch;
		return { start: p + 1, end: Math.min(q, limit), resume: closed ? q + 1 : Math.min(q, limit) };
	}
	let q = p;
	const eol = () => q < limit && text[q] !== "\n" && text[q] !== "\r";
	if (fam === "strong" && !oneToken) {
		if (flow) while (eol() && !",;)]}".includes(text[q])) q++;
		else while (eol()) q++;
		if (q >= limit && limit < text.length) {
			const e = overrun(text, q, null);
			return { start: p, end: e, resume: e, truncated: true };
		}
		let e = q;
		while (e > p && (text[e - 1] === " " || text[e - 1] === "\t")) e--;
		return { start: p, end: e, resume: q };
	}
	while (eol() && !/[\s"'`]/.test(text[q])) {
		if (sep === ":" && ",;{}()[]".includes(text[q])) break;
		if (text[q] === "&" && /^&[\w.\-]{1,64}=/.test(text.slice(q, q + 66))) break;
		q++;
	}
	if (q >= limit && limit < text.length) {
		const e = overrun(text, q, null);
		return { start: p, end: e, resume: e, truncated: true };
	}
	return { start: p, end: q, resume: q };
}

/**
 * Scrub provider secrets from `text`. Returns the redacted text, a count
 * of replacements, and the unique set of rule ids that fired.
 *
 * Replacement format: `[REDACTED:<rule-id>]`. Names, schemes, hosts and
 * separators are kept so the output stays readable.
 */
export function scrub(text: string): ScrubResult {
	if (!text) return { scrubbed: text ?? "", redactedCount: 0, rules: [] };

	let count = 0;
	const firedRules = new Set<string>();
	const fire = (id: string) => {
		count++;
		firedRules.add(id);
	};

	let out = text;
	let capped = false;
	if (out.length > MAX_SCAN_CHARS) {
		out = out.slice(0, MAX_SCAN_CHARS);
		capped = true;
	}

	for (const rule of RULES) {
		const replacement = `[REDACTED:${rule.id}]`;
		rule.pattern.lastIndex = 0;
		out = out.replace(rule.pattern, (m) => {
			if (rule.accept && !rule.accept(m)) return m;
			fire(rule.id);
			return replacement;
		});
	}

	out = out.replace(URL_PASSWORD, (match, scheme: string, user: string, pass: string) => {
		if (pass.includes("[REDACTED:") || isPlaceholder(pass) || /^(?:pass|password)$/i.test(pass))
			return match;
		if (/^\d{1,5}(?:\/|$)/.test(pass)) return match; // host:port/path@x, not a password
		fire("url_password");
		return `${scheme}${user}:[REDACTED:url_password]@`;
	});
	out = out.replace(URL_TOKEN, (match, scheme: string, tok: string) => {
		if (tok.includes("[REDACTED:") || isPlaceholder(tok)) return match;
		if (!(tok.length >= 16 || hasLetterDigit(tok))) return match;
		fire("url_password");
		return `${scheme}[REDACTED:url_password]@`;
	});

	out = out.replace(
		AUTH_HEADER,
		(match, head: string, scheme: string | undefined, gap: string | undefined, line: string) => {
			// Digest params carry their own quotes, so they run to end of line.
			// Other values stop at a quote (curl -H "Authorization: ...").
			const cut = scheme?.toLowerCase() === "digest" ? -1 : line.search(/["'`]/);
			const value = cut === -1 ? line : line.slice(0, cut);
			const after = cut === -1 ? "" : line.slice(cut);
			const v = value.trim();
			if (!v || v.includes("[REDACTED:") || isPlaceholder(v) || isCode(v)) return match;
			if (!scheme && !(v.length >= 16 || hasLetterDigit(v))) return match;
			fire("auth_header");
			const trail = value.slice(value.trimEnd().length);
			return `${head}${scheme ? scheme + gap : ""}[REDACTED:auth_header]${trail}${after}`;
		},
	);
	out = out.replace(COOKIE_HEADER, (_match, name: string, sep: string, body: string) => {
		const setCookie = name.toLowerCase() === "set-cookie";
		let done = false;
		const red = body.replace(
			/(^|;[ \t]*)([^=;\s]{1,256})=([^;\r\n]*)/g,
			(m, lead: string, k: string, v: string) => {
				if (done) return m;
				if (setCookie) done = true; // only the first pair; the rest are attributes
				if (!v.trim() || v.includes("[REDACTED:") || isPlaceholder(v.trim())) return m;
				fire("cookie");
				return `${lead}${k}=[REDACTED:cookie]`;
			},
		);
		return `${name}${sep}${red}`;
	});
	out = out.replace(BEARER, (match, head: string, tok: string) => {
		if (tok.includes("REDACTED")) return match;
		fire("auth_header");
		return `${head}[REDACTED:auth_header]`;
	});

	out = out.replace(CURL_USER, (match, head: string, q: string, user: string, pass: string) => {
		if (pass.includes("[REDACTED:") || isPlaceholder(pass)) return match;
		fire("cli_password");
		return `${head}${q}${user}:[REDACTED:cli_password]${q}`;
	});
	for (const re of [SSHPASS, MYSQL_P]) {
		out = out.replace(re, (match, head: string, sq?: string, dq?: string, bare?: string) => {
			const v = sq ?? dq ?? bare ?? "";
			if (!v || v.includes("[REDACTED:") || isPlaceholder(v)) return match;
			fire("cli_password");
			const q = sq !== undefined ? "'" : dq !== undefined ? '"' : "";
			return `${head}${q}[REDACTED:cli_password]${q}`;
		});
	}
	out = redactAssignments(out, LONG_FLAG, fire, true);

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

	if (NAME_PREFILTER.test(out)) out = redactAssignments(out, NAME_SEP, fire, false);

	if (capped) {
		fire("input_cap");
		out += `\n[REDACTED:input_cap] ${text.length - MAX_SCAN_CHARS} chars past the scan limit dropped`;
	}

	return { scrubbed: out, redactedCount: count, rules: [...firedRules].sort() };
}

function looksLikeAwsSecret(v: string): boolean {
	// Real secrets mix cases and digits. A git SHA is lowercase hex only.
	return /[A-Z]/.test(v) && /[a-z]/.test(v) && /[0-9\/+]/.test(v);
}

/**
 * Walk name+separator matches and redact the values of secret-named ones.
 * For --flags, group 1 is the flag name and group 2 the separator. For
 * assignments, group 1 is the name quote, 2 the name, 4 the separator.
 */
function redactAssignments(
	text: string,
	re: RegExp,
	fire: (id: string) => void,
	isFlag: boolean,
): string {
	const parts: string[] = [];
	let last = 0;
	re.lastIndex = 0;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		const name = isFlag ? m[1] : m[2];
		const rawSep = isFlag ? m[2] : m[4];
		const sep = rawSep.trim() === "" ? " " : rawSep;
		const fam = family(name);
		if (!fam) continue;
		const valPos = m.index + m[0].length;
		// A space-separated flag takes the next argument only for unambiguous
		// value flags; --private and --auth-* are often boolean switches.
		if (isFlag && sep === " " && fam !== "weak" && !/pass|pwd|secret/i.test(name)) continue;
		if (isFlag && sep === " " && text[valPos] === "-") continue;

		// YAML block scalar under a secret-named key: redact the indented body.
		if (!isFlag && sep === ":") {
			const head = text.slice(valPos, valPos + 64);
			const nlAt = head.indexOf("\n");
			const lineEnd = nlAt === -1 ? -1 : valPos + nlAt;
			if (lineEnd !== -1 && YAML_BLOCK_HEAD.test(head.slice(0, nlAt).trim())) {
				const lineStart = lineStartBefore(text, m.index);
				const indent = /^[ \t-]*/.exec(text.slice(lineStart, m.index))?.[0].length ?? 0;
				let q = lineEnd + 1;
				let bodyEnd = q;
				while (q < text.length) {
					const nl = text.indexOf("\n", q);
					const line = text.slice(q, nl === -1 ? text.length : nl);
					const lead = /^[ \t]*/.exec(line)?.[0].length ?? 0;
					if (line.trim() !== "" && lead <= indent) break;
					q = nl === -1 ? text.length : nl + 1;
					if (line.trim() !== "") bodyEnd = q;
				}
				if (bodyEnd > lineEnd + 1) {
					parts.push(
						text.slice(last, lineEnd + 1),
						`${" ".repeat(indent + 2)}[REDACTED:secret_assignment]\n`,
					);
					fire("secret_assignment");
					last = bodyEnd;
					re.lastIndex = bodyEnd;
				}
				continue;
			}
		}

		const lineStart = lineStartBefore(text, m.index);
		const flow = !isFlag && (m[1] !== "" || /[{\[]/.test(text.slice(lineStart, m.index)));
		const span = parseValue(text, valPos, fam, sep, flow, isFlag);
		if (!span || span.end <= span.start) continue;
		const value = text.slice(span.start, span.end);
		if (!span.truncated && !shouldRedact(value, fam)) continue;
		parts.push(text.slice(last, span.start), "[REDACTED:secret_assignment]");
		fire("secret_assignment");
		last = span.end;
		re.lastIndex = Math.max(span.resume, re.lastIndex);
	}
	if (last === 0) return text;
	parts.push(text.slice(last));
	return parts.join("");
}

/**
 * Strict shape of the one line the harness emits for an image attachment:
 * `<marker> data:<image mime>;base64,<pure base64>`. Pure base64 only, so the
 * exemption can never carry readable text.
 */
/** Upper bound on an exempt data URL, in base64 chars. Larger falls back to the full scrub. */
export const MAX_ATTACHMENT_BASE64_CHARS = 64 * 1024 * 1024;

function attachmentLineRe(marker: string): RegExp {
	const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// Allowlist of what resizeImage can emit: sharp keeps the input format
	// (`image/${format}`, jpg mapped to jpeg), and an SVG input rasterizes to png.
	// svg+xml and any other subtype fall back to the full scrub.
	return new RegExp(
		`^${esc} data:image/(?:png|jpeg|gif|webp|avif|heif|tiff);base64,[A-Za-z0-9+/]+={0,2}$`,
	);
}

/**
 * scrub() for a tool result that may end in a harness-emitted image attachment
 * (read_image). That line is a base64 data URL that can pass MAX_SCAN_CHARS;
 * cutting it corrupts the image and the model endpoint answers 400. Only the
 * FINAL line, and only when it matches the strict attachment shape, is held
 * out; everything else, including any earlier look-alike line, is scanned as
 * usual. The cap is unchanged.
 */
export function scrubKeepingAttachment(text: string, marker: string): ScrubResult {
	const cut = text.lastIndexOf("\n");
	const last = cut === -1 ? text : text.slice(cut + 1);
	if (
		cut === -1 ||
		last.length > MAX_ATTACHMENT_BASE64_CHARS + 128 ||
		!attachmentLineRe(marker).test(last)
	) {
		return scrub(text);
	}
	const result = scrub(text.slice(0, cut));
	return { ...result, scrubbed: `${result.scrubbed}\n${last}` };
}
