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

export type MaskType = "secret" | "email" | "phone" | "ip" | "path" | "term";
export const MASK_TYPES: readonly MaskType[] = ["secret", "email", "phone", "ip", "path", "term"];

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
	/** True when `text` still holds something the masker would hide. */
	leaks(text: string): boolean;
}

const emptyCounts = (): MaskCounts => ({ secret: 0, email: 0, phone: 0, ip: 0, path: 0, term: 0 });

const PLACEHOLDER = /\{\{[A-Z]+_\d+\}\}/g;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

const KEY_SHAPES: RegExp[] = [
	/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{30,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{30,}/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
	/\bAIza[0-9A-Za-z_-]{30,}/g,
	/\bhf_[A-Za-z0-9]{30,}/g,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

const BEARER = /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{16,})/g;

const ASSIGNMENT =
	/\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|credential)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)([^\s"',;]{6,})/gi;

/** A long run of key characters that mixes letters and digits: a hash, a token, a base64 blob. */
const LONG_TOKEN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_-])/g;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;
const IPV6 = /(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}(?![0-9A-Fa-f:])/g;

const PHONE = /(?<![\w.])\+?\(?\d[\d\s().-]{6,}\d(?!\w)/g;

const POSIX_HOME = /\/(?:Users|home)\/[^/\s"'`)\]}<>]+(?:\/[^\s"'`)\]}<>:,;]*)?/g;
const WIN_HOME = /\b[A-Za-z]:\\Users\\[^\\\s"'`)<>]+(?:\\[^\s"'`)<>]*)?/g;

const isLoopback = (ip: string) => ip.startsWith("127.") || ip === "0.0.0.0";

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
			(t) => new RegExp(`(?<![A-Za-z0-9_])${escapeRe(t).replace(/\s+/g, "\\s+")}(?![A-Za-z0-9_])`, "gi"),
		);
	const homeRes: RegExp[] = [];
	if (opts.hostIdentity !== false) {
		try {
			const h = homedir();
			if (h && h.length > 4) homeRes.push(new RegExp(`${escapeRe(h)}(?:/[^\\s"'\`)\\]}<>:,;]*)?`, "g"));
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

	const skip = (s: string) => s.includes("{{");

	function run(text: string): string {
		let t = text;
		t = t.replace(PEM, (m) => place("secret", m));
		for (const re of KEY_SHAPES) t = t.replace(re, (m) => (skip(m) ? m : place("secret", m)));
		t = t.replace(BEARER, (_m, scheme, sp, tok) =>
			skip(tok) ? _m : `${scheme}${sp}${place("secret", tok)}`,
		);
		t = t.replace(ASSIGNMENT, (m, name, sep, q, val) =>
			skip(val) ? m : `${name}${sep}${q}${place("secret", val)}`,
		);
		t = t.replace(LONG_TOKEN, (m) => (skip(m) || !mixed(m) ? m : place("secret", m)));
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
		t = t.replace(IPV6, (m) => place("ip", m));
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
		term: ["listed term", "listed terms"],
	};
	const parts = MASK_TYPES.filter((k) => c[k] > 0).map(
		(k) => `${c[k]} ${label[k][c[k] === 1 ? 0 : 1]}`,
	);
	return parts.length ? parts.join(", ") : null;
}
