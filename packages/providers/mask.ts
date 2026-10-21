/**
 * Masker (#4608): before a request goes to a cloud model, replace secrets and
 * personal data with stable placeholders, and put the real values back into the
 * reply on this machine.
 *
 * Pure apart from the closure it keeps: one Masker is one request. Its map of
 * placeholder to original lives only in that closure. There is no method that
 * returns, serialises or writes the map, and nothing in this file touches the
 * disk or the ledger.
 *
 * What it catches: key and token shapes, private key blocks, key=value secrets,
 * emails, phone numbers, IPv4 and full IPv6 addresses, absolute home paths, the
 * current OS username and home directory, and the caller's own terms (names,
 * client names, project names). See the PR for what it does not catch.
 */
import { homedir, userInfo } from "node:os";

export type MaskType = "secret" | "email" | "phone" | "ip" | "path" | "card" | "term";
export const MASK_TYPES: readonly MaskType[] = [
	"secret",
	"email",
	"phone",
	"ip",
	"path",
	"card",
	"term",
];

export type MaskCounts = Record<MaskType, number>;

export interface MaskOptions {
	/** Words to hide wherever they appear, case-insensitive: names, clients, projects. */
	terms?: readonly string[];
	/** Also hide this machine's OS username and home directory. Default true. */
	hostIdentity?: boolean;
}

export interface Masker {
	/** Mask one string. Same original gives the same placeholder for the life of this Masker. */
	mask(text: string): string;
	/** Mask the content of every message; roles and other fields are kept. */
	maskMessages<T extends { content: string }>(messages: readonly T[]): T[];
	/** Put the real values back. Placeholders this Masker did not make are left alone. */
	unmask(text: string): string;
	/** Distinct values hidden so far, by type. Numbers only. */
	counts(): MaskCounts;
	/**
	 * True when `text` still holds something this masker would hide. A regression
	 * guard only: it reuses the masker's own patterns, so it cannot catch a shape
	 * the masker does not know. coarseLeaks() is the independent check.
	 */
	leaks(text: string): boolean;
}

const emptyCounts = (): MaskCounts => ({
	secret: 0,
	email: 0,
	phone: 0,
	ip: 0,
	path: 0,
	card: 0,
	term: 0,
});

const PLACEHOLDER = /\{\{[A-Z]+_\d+\}\}/g;
/** Splits around our own placeholders, keeping them (odd indexes). */
const OURS_SPLIT = /(\{\{[A-Z]+_\d+\}\})/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Every quantifier below is bounded or anchored to a run start, so hostile input
// cannot make it quadratic. consult.ts also caps the input size before masking.

const PEM =
	/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g;

const KEY_SHAPES: RegExp[] = [
	/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
	/\b(?:sk|pk|rk|whsec)_[A-Za-z0-9_]{16,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{30,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{30,}/g,
	/\bnpm_[A-Za-z0-9]{20,}/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
	/\bAIza[0-9A-Za-z_-]{30,}/g,
	/\bhf_[A-Za-z0-9]{30,}/g,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
	/\b(?:ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-nistp\d{3})[ \t]+[A-Za-z0-9+/=]{20,}(?:[ \t]+\S{1,100})?/g,
];

const BEARER = /\b(Bearer|Basic|Token|ApiKey)(\s{1,4})([A-Za-z0-9._~+/=-]{16,})/g;
const AUTH_HEADER =
	/\b(authorization\s{0,4}[:=：＝]\s{0,4}(?:[A-Za-z]{2,20}\s{1,4})?)([^\s"',;]{6,})/gi;

const NAME_KW = "api[_-]?key|secret|token|passw(?:or)?d|pwd|credential|private|auth|dsn|key";
const ASSIGN_QUOTED = new RegExp(
	`\\b([A-Za-z0-9_.-]{0,64}(?:${NAME_KW})[A-Za-z0-9_.-]{0,32})(\\s{0,4}[:=：＝]\\s{0,4})(["'])([^"'\\n]{4,200})\\3`,
	"gi",
);
const ASSIGN_BARE = new RegExp(
	`\\b([A-Za-z0-9_.-]{0,64}(?:${NAME_KW})[A-Za-z0-9_.-]{0,32})(\\s{0,4}[:=：＝]\\s{0,4})([^\\s"',;]{6,})`,
	"gi",
);
/** A .env line: UPPER_CASE_NAME=value with a value of 8 or more characters. */
const ENV_QUOTED =
	/^([ \t]{0,20}(?:export[ \t]+)?[A-Z][A-Z0-9_]{2,63}[ \t]{0,4}=[ \t]{0,4})(["'])([^"'\n]{8,200})\2/gm;
const ENV_BARE =
	/^([ \t]{0,20}(?:export[ \t]+)?[A-Z][A-Z0-9_]{2,63}[ \t]{0,4}=[ \t]{0,4})([^\s"']{8,})/gm;

/** scheme://user:pass@host and scheme://token@host. */
const URL_USERINFO = /\b([A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/)([^\s/@?#]{1,128})@/g;
/** curl -u user:pass, --user user:pass. */
const CURL_USER = /(^|\s)(-u|--user)([ \t]+|=)(["']?)([^\s"']{1,200}:[^\s"']{1,200})\4/g;

/** A long run of key characters that mixes letters and digits: a hash, a token, a base64 blob. */
const LONG_TOKEN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_-])/g;

const EMAIL =
	/[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){0,8}\.\p{L}{2,24}/gu;

const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;
/** Candidate IPv6, full or compressed; validated by isIPv6. */
const IPV6 = /(?<![0-9A-Za-z:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Za-z:])/g;

const CARD = /(?<![\d.-])\d(?:[ -]?\d){12,18}(?!\d)/g;
const PHONE = /(?<![\w.])\+?\(?\d[\d\s().-]{6,30}\d(?!\w)/g;

const POSIX_HOME = /\/(?:Users|home)\/[^/\s"'`)\]}<>]+(?:\/[^\s"'`)\]}<>:,;]*)?/g;
const WIN_HOME = /\b[A-Za-z]:\\Users\\[^\\\s"'`)<>]+(?:\\[^\s"'`)<>]*)?/g;

const isLoopback = (ip: string) => ip.startsWith("127.") || ip === "0.0.0.0";

function isIPv6(s: string): boolean {
	if (s === "::" || s === "::1") return false;
	const dbl = s.indexOf("::");
	if (dbl !== s.lastIndexOf("::")) return false;
	const groups = s.split(":");
	if (dbl === -1) return groups.length === 8 && groups.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g));
	const nonEmpty = groups.filter((g) => g !== "");
	return nonEmpty.length <= 7 && nonEmpty.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g));
}

function luhn(digits: string): boolean {
	let sum = 0;
	let dbl = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let d = digits.charCodeAt(i) - 48;
		if (dbl) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
		dbl = !dbl;
	}
	return sum % 10 === 0;
}

function looksLikePhone(s: string): boolean {
	const digits = s.replace(/\D/g, "").length;
	if (digits < 9 || digits > 15) return false;
	return s.startsWith("+") || /[\s().-]/.test(s);
}

const mixed = (s: string) => /[A-Za-z]/.test(s) && /\d{3}/.test(s);

/** Trailing sentence punctuation is not part of a path: keep it outside the placeholder. */
function splitTail(s: string): [string, string] {
	const m = /[.,;:!?]+$/.exec(s);
	return m ? [s.slice(0, m.index), m[0]] : [s, ""];
}

/**
 * A coarse second check, deliberately NOT built from the masker's patterns: it
 * looks at what is about to leave. True when the text, with our own placeholders
 * removed, still holds credentials in a URL, an = followed by 20 or more
 * mixed-case characters, or a run of 40 or more token characters. It over-refuses
 * on purpose: a long kebab-case name will trip it, and the person can reword.
 */
export function coarseLeaks(text: string): boolean {
	const t = text.replace(PLACEHOLDER, " ");
	if (/:\/\/[^\s/@]{1,200}:[^\s/@]{1,200}@/.test(t)) return true;
	if (
		/[=：＝]\s{0,4}["']?(?=[A-Za-z0-9+/_-]{0,200}[a-z])(?=[A-Za-z0-9+/_-]{0,200}[A-Z])[A-Za-z0-9+/_-]{20,}/.test(
			t,
		)
	)
		return true;
	return /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}/.test(t);
}

export function createMasker(opts: MaskOptions = {}): Masker {
	const toOriginal = new Map<string, string>();
	const toPlaceholder = new Map<string, string>();
	const perType = new Map<MaskType, number>();
	/** Everything seen as input, so a placeholder is never numbered to match text the user typed. */
	let reserved = "";

	const terms: string[] = [...(opts.terms ?? [])].map((t) => t.trim()).filter((t) => t.length >= 2);
	if (opts.hostIdentity !== false) {
		try {
			const u = userInfo().username;
			if (u && u.length >= 3) terms.push(u);
		} catch {
			// no passwd entry: nothing to add
		}
	}
	const termRes = [...new Set(terms.map((t) => t.toLowerCase()))]
		.sort((a, b) => b.length - a.length)
		.map(
			(t) =>
				new RegExp(`(?<![A-Za-z0-9_])${escapeRe(t).replace(/\s+/g, "\\s+")}(?![A-Za-z0-9_])`, "gi"),
		);
	const homeRes: RegExp[] = [];
	if (opts.hostIdentity !== false) {
		try {
			const h = homedir();
			if (h && h.length > 4)
				homeRes.push(new RegExp(`${escapeRe(h)}(?:/[^\\s"'\`)\\]}<>:,;]*)?`, "g"));
		} catch {
			// no home: nothing to add
		}
	}

	const place = (type: MaskType, original: string): string => {
		const key = `${type}\u0000${original}`;
		const have = toPlaceholder.get(key);
		if (have) return have;
		let n = (perType.get(type) ?? 0) + 1;
		let ph = `{{${type.toUpperCase()}_${n}}}`;
		while (reserved.includes(ph)) {
			n++;
			ph = `{{${type.toUpperCase()}_${n}}}`;
		}
		perType.set(type, n);
		toPlaceholder.set(key, ph);
		toOriginal.set(ph, original);
		return ph;
	};

	/** Hide `s` except for our own placeholders inside it, so a stray "{{" cannot shield a secret. */
	const hide = (type: MaskType, s: string): string =>
		s
			.split(OURS_SPLIT)
			.map((seg, i) => (i % 2 === 1 || seg === "" ? seg : place(type, seg)))
			.join("");

	function run(text: string): string {
		let t = text;
		t = t.replace(PEM, (m) => hide("secret", m));
		for (const re of KEY_SHAPES) t = t.replace(re, (m) => hide("secret", m));
		t = t.replace(URL_USERINFO, (_m, scheme, user) => `${scheme}${hide("secret", user)}@`);
		t = t.replace(
			CURL_USER,
			(_m, lead, flag, sep, q, val) => `${lead}${flag}${sep}${q}${hide("secret", val)}${q}`,
		);
		t = t.replace(AUTH_HEADER, (_m, head, val) => `${head}${hide("secret", val)}`);
		t = t.replace(BEARER, (_m, scheme, sp, tok) => `${scheme}${sp}${hide("secret", tok)}`);
		t = t.replace(
			ASSIGN_QUOTED,
			(_m, name, sep, q, val) => `${name}${sep}${q}${hide("secret", val)}${q}`,
		);
		t = t.replace(ASSIGN_BARE, (_m, name, sep, val) => `${name}${sep}${hide("secret", val)}`);
		t = t.replace(ENV_QUOTED, (_m, head, q, val) => `${head}${q}${hide("secret", val)}${q}`);
		t = t.replace(ENV_BARE, (_m, head, val) => `${head}${hide("secret", val)}`);
		t = t.replace(LONG_TOKEN, (m) => (mixed(m) ? hide("secret", m) : m));
		for (const re of homeRes) {
			t = t.replace(re, (m) => {
				const [body, tail] = splitTail(m);
				return place("path", body) + tail;
			});
		}
		t = t.replace(POSIX_HOME, (m) => {
			const [body, tail] = splitTail(m);
			return place("path", body) + tail;
		});
		t = t.replace(WIN_HOME, (m) => {
			const [body, tail] = splitTail(m);
			return place("path", body) + tail;
		});
		t = t.replace(EMAIL, (m) => place("email", m));
		t = t.replace(IPV4, (m) => (isLoopback(m) ? m : place("ip", m)));
		t = t.replace(IPV6, (m) => (isIPv6(m) ? place("ip", m) : m));
		t = t.replace(CARD, (m) => {
			const d = m.replace(/\D/g, "");
			return d.length >= 13 && d.length <= 19 && luhn(d) ? place("card", m) : m;
		});
		t = t.replace(PHONE, (m) => (looksLikePhone(m) ? place("phone", m) : m));
		for (const re of termRes) t = t.replace(re, (m) => place("term", m));
		return t;
	}

	return {
		mask(text) {
			reserved += `\n${text}`;
			return run(text);
		},
		maskMessages(messages) {
			for (const m of messages) reserved += `\n${m.content}`;
			return messages.map((m) => ({ ...m, content: run(m.content) }));
		},
		unmask(text) {
			return text.replace(PLACEHOLDER, (ph) => toOriginal.get(ph) ?? ph);
		},
		counts() {
			const c = emptyCounts();
			for (const [k, n] of perType) c[k] = n;
			return c;
		},
		leaks(text) {
			const probe = createMasker({ terms, hostIdentity: false });
			const clean = text.replace(PLACEHOLDER, "");
			return probe.mask(clean) !== clean;
		},
	};
}

/** "2 secrets, 1 email" from counts; null when nothing was hidden. Types and numbers only. */
export function describeCounts(c: MaskCounts): string | null {
	const label: Record<MaskType, [string, string]> = {
		secret: ["secret", "secrets"],
		email: ["email", "emails"],
		phone: ["phone number", "phone numbers"],
		ip: ["IP address", "IP addresses"],
		path: ["home path", "home paths"],
		card: ["card number", "card numbers"],
		term: ["listed term", "listed terms"],
	};
	const parts = MASK_TYPES.filter((k) => c[k] > 0).map(
		(k) => `${c[k]} ${label[k][c[k] === 1 ? 0 : 1]}`,
	);
	return parts.length ? parts.join(", ") : null;
}
