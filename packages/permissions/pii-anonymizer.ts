/**
 * 8gent Code - PII Anonymizer (cloud-egress boundary)
 *
 * HARD RULE: no personally-identifiable information may ever reach a cloud
 * provider. This module is the local, deterministic, fail-safe gate that sits
 * at the single cloud-egress chokepoint (`packages/providers/index.ts`).
 *
 * Design contract:
 *   - LOCAL ONLY. Pure string transforms. No network, no disk, no telemetry.
 *   - DETERMINISTIC per request: the same raw value maps to the same pseudonym
 *     within one request, so the cloud model still sees a coherent conversation.
 *   - FAIL-SAFE: over-redact rather than under. A false positive (masking a
 *     non-PII token) is cheap; a false negative (leaking real PII) is the one
 *     thing we never do.
 *   - EPHEMERAL: the reverse map lives only inside the returned object, for the
 *     life of one request. We never persist the map or the raw PII to disk.
 *
 * Detection coverage (in priority order, longest/most-specific first):
 *   emails, IBANs, credit-card numbers, SSNs, phone numbers, physical
 *   addresses, and full names - including the owner's known identity, which is
 *   always masked even when it would not otherwise look name-shaped.
 *
 * This module is additive. It does NOT modify the policy engine. The egress
 * chokepoint imports `anonymize` / `deanonymize` / `verifyClean`; the privacy
 * router can import `containsPii` for fail-closed routing decisions.
 */

// ============================================
// Owner identity (known PII that must always be masked)
// ============================================

/**
 * The owner's known identity. These are masked unconditionally - even bare
 * first names or an email that would otherwise slip past the generic patterns.
 * Pulled from the local profile (CLAUDE.md / contacts). Extendable at runtime
 * via `registerOwnerIdentity()` so callers can fold in values discovered from
 * the local contacts store without persisting anything here.
 */
const OWNER_IDENTITY: { value: string; type: PiiType }[] = [
	{ value: "James Spalding", type: "PERSON" },
	{ value: "jamesspaldingles@gmail.com", type: "EMAIL" },
	{ value: "James Spalding", type: "PERSON" },
];

/**
 * Bare owner first/last names. Masked as PERSON even when standing alone.
 * Kept separate so we only fire on whole-word matches (avoid mangling
 * substrings like "james" inside "jamestown").
 */
const OWNER_NAME_TOKENS = ["James", "Spalding"];

const runtimeOwnerIdentity: { value: string; type: PiiType }[] = [];
const runtimeOwnerTokens: string[] = [];

/**
 * Fold additional owner-identity values (e.g. from the local contacts store)
 * into the masking set for this process. Values are held in memory only.
 */
export function registerOwnerIdentity(
	entries: Array<{ value: string; type: PiiType }>,
	bareNameTokens: string[] = [],
): void {
	for (const e of entries) {
		const v = e.value.trim();
		if (v.length >= 2 && !runtimeOwnerIdentity.some((r) => r.value === v)) {
			runtimeOwnerIdentity.push({ value: v, type: e.type });
		}
	}
	for (const t of bareNameTokens) {
		const tok = t.trim();
		if (tok.length >= 2 && !runtimeOwnerTokens.includes(tok)) {
			runtimeOwnerTokens.push(tok);
		}
	}
}

// ============================================
// Types
// ============================================

export type PiiType =
	| "PERSON"
	| "EMAIL"
	| "PHONE"
	| "ADDRESS"
	| "CREDIT_CARD"
	| "IBAN"
	| "SSN";

export interface AnonymizeResult {
	/** Text with all detected PII replaced by stable pseudonyms. */
	text: string;
	/**
	 * In-memory reverse map: pseudonym -> raw value. Lives only as long as the
	 * caller holds this object. NEVER persisted.
	 */
	map: Map<string, string>;
	/** Count of distinct PII entities masked. */
	count: number;
}

// ============================================
// Detection patterns
// ============================================

// Email - RFC-ish, deliberately broad.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// IBAN - 2 letters, 2 check digits, up to 30 alnum (optionally space-grouped).
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Za-z0-9]){11,30}\b/g;

// Credit card - 13-19 digits, allowing spaces or dashes between groups.
const CREDIT_CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;

// US SSN - 3-2-4 with dashes or spaces.
const SSN_RE = /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g;

/**
 * Phone numbers - international and domestic. Intentionally greedy: an optional
 * leading +, optional country/area grouping, 7+ significant digits total.
 * We over-match (e.g. some long ID numbers) on purpose - fail-safe.
 */
const PHONE_RE =
	/(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]?\d{2,4}){2,4}\b/g;

/**
 * Physical address - a street line: number + words + a street-type suffix.
 * Broad on the suffix list; tolerant of unit/apartment suffixes.
 */
const ADDRESS_RE = new RegExp(
	String.raw`\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){0,5}` +
		String.raw`(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Square|Sq|Terrace|Way|Close|Crescent|Parkway|Pkwy|Highway|Hwy|Circle|Cir|Trail|Trl)` +
		String.raw`\b\.?(?:[,\s]+(?:Apt|Apartment|Suite|Ste|Unit|Floor|Fl)\.?\s*#?\s*\w+)?`,
	"gi",
);

/**
 * Full personal names - two or more capitalized words in a row. This is the
 * loosest detector and the most likely to false-positive on capitalized
 * phrases ("New York", "United States"). That is acceptable under the
 * fail-safe rule: masking a place name does not leak PII and the model still
 * reads coherently via the stable pseudonym. We keep a small stop-list to
 * avoid mangling the most common non-PII capitalized bigrams that show up in
 * code/agent chat, but err toward masking when uncertain.
 */
const FULLNAME_RE = /\b([A-Z][a-z]+)(?:\s+(?:[A-Z]\.|[A-Z][a-z]+)){1,3}\b/g;

/**
 * Stop-list: capitalized multi-word phrases that are common in agent/officer
 * chat and code, are not personal names, and would be noisy if masked. Kept
 * deliberately tiny - when in doubt we mask.
 */
const NAME_STOPLIST = new Set([
	"United States",
	"New York",
	"San Francisco",
	"Los Angeles",
	"Hong Kong",
	"Pull Request",
	"Open Source",
	"Apache License",
	"North America",
	"South America",
]);

// ============================================
// Anonymize
// ============================================

interface Detector {
	type: PiiType;
	re: RegExp;
	/**
	 * Overlap priority. Higher wins when two detected spans start at the same
	 * index. Specific financial identifiers must outrank the greedy PHONE
	 * detector (a card/IBAN/SSN is a run of digits a phone regex also matches).
	 */
	priority: number;
	/** Optional post-match validator. Return false to reject a candidate. */
	accept?: (match: string) => boolean;
}

/** Priority above any generic detector - owner identity always wins. */
const OWNER_PRIORITY = 100;

/**
 * Order matters: most-specific / longest patterns first so an email is not
 * partly eaten by the phone-number detector, an address is masked before its
 * embedded number is seen as a card, etc.
 */
const DETECTORS: Detector[] = [
	{ type: "EMAIL", re: EMAIL_RE, priority: 90 },
	{ type: "IBAN", re: IBAN_RE, priority: 80, accept: (m) => m.replace(/\s/g, "").length >= 15 },
	{ type: "ADDRESS", re: ADDRESS_RE, priority: 70 },
	{
		type: "CREDIT_CARD",
		re: CREDIT_CARD_RE,
		priority: 60,
		accept: (m) => {
			const digits = m.replace(/[ -]/g, "");
			return digits.length >= 13 && digits.length <= 19;
		},
	},
	{ type: "SSN", re: SSN_RE, priority: 55 },
	{
		type: "PHONE",
		re: PHONE_RE,
		priority: 30,
		accept: (m) => m.replace(/\D/g, "").length >= 7,
	},
	{ type: "PERSON", re: FULLNAME_RE, priority: 20, accept: (m) => !NAME_STOPLIST.has(m.trim()) },
];

interface Span {
	start: number;
	end: number;
	type: PiiType;
	raw: string;
	priority: number;
}

/**
 * Anonymize text: replace every detected PII entity (and every known owner
 * identity value) with a stable per-request pseudonym. The same raw value
 * always maps to the same pseudonym within this call.
 */
export function anonymize(text: string): AnonymizeResult {
	if (!text) return { text, map: new Map(), count: 0 };

	const spans: Span[] = [];

	// 1. Owner identity first - unconditional, highest priority, exact substring.
	for (const { value, type } of [...OWNER_IDENTITY, ...runtimeOwnerIdentity]) {
		collectLiteral(text, value, type, spans);
	}
	for (const tok of [...OWNER_NAME_TOKENS, ...runtimeOwnerTokens]) {
		// whole-word only
		const re = new RegExp(`\\b${escapeRegExp(tok)}\\b`, "g");
		for (let m = re.exec(text); m; m = re.exec(text)) {
			spans.push({
				start: m.index,
				end: m.index + m[0].length,
				type: "PERSON",
				raw: m[0],
				priority: OWNER_PRIORITY,
			});
		}
	}

	// 2. Generic detectors.
	for (const det of DETECTORS) {
		det.re.lastIndex = 0;
		for (let m = det.re.exec(text); m; m = det.re.exec(text)) {
			const raw = m[0];
			if (det.accept && !det.accept(raw)) continue;
			spans.push({
				start: m.index,
				end: m.index + raw.length,
				type: det.type,
				raw,
				priority: det.priority,
			});
		}
	}

	if (spans.length === 0) return { text, map: new Map(), count: 0 };

	// 3. Resolve overlaps. Process candidates in order of priority (most-specific
	//    type first), then widest, then leftmost. Keep a span only if its range
	//    is not already covered by a higher-priority kept span. This guarantees
	//    a card/IBAN/SSN wins over the greedy phone detector, and we never emit
	//    a half-masked entity.
	spans.sort(
		(a, b) =>
			b.priority - a.priority ||
			b.end - b.start - (a.end - a.start) ||
			a.start - b.start,
	);
	const kept: Span[] = [];
	for (const s of spans) {
		const overlaps = kept.some((k) => s.start < k.end && s.end > k.start);
		if (!overlaps) kept.push(s);
	}
	// Re-sort kept spans left-to-right for the rebuild pass.
	kept.sort((a, b) => a.start - b.start);

	// 4. Assign stable pseudonyms (per raw value) and build the reverse map.
	const map = new Map<string, string>();
	const rawToToken = new Map<string, string>();
	const counters: Record<string, number> = {};

	const tokenFor = (raw: string, type: PiiType): string => {
		const key = `${type}::${raw}`;
		const existing = rawToToken.get(key);
		if (existing) return existing;
		counters[type] = (counters[type] ?? 0) + 1;
		const token = `[${type}_${counters[type]}]`;
		rawToToken.set(key, token);
		map.set(token, raw);
		return token;
	};

	// 5. Rebuild the string left-to-right from the kept spans.
	let out = "";
	let last = 0;
	for (const s of kept) {
		out += text.slice(last, s.start);
		out += tokenFor(s.raw, s.type);
		last = s.end;
	}
	out += text.slice(last);

	return { text: out, map, count: map.size };
}

/**
 * Anonymize a list of chat messages (officer chat / judge shape). Shares ONE
 * reverse map across all messages so the same person/email is the same
 * pseudonym in the system prompt and the user turn.
 */
export function anonymizeMessages<T extends { role: string; content: string }>(
	messages: T[],
): { messages: T[]; map: Map<string, string>; count: number } {
	const map = new Map<string, string>();
	const rawToToken = new Map<string, string>();
	const counters: Record<string, number> = {};
	const out: T[] = [];

	for (const msg of messages) {
		const r = anonymize(msg.content ?? "");
		// Re-key this message's local pseudonyms onto the shared, stable map.
		let rewritten = r.text;
		for (const [localToken, raw] of r.map.entries()) {
			const type = localToken.slice(1, localToken.indexOf("_")) as PiiType;
			const key = `${type}::${raw}`;
			let shared = rawToToken.get(key);
			if (!shared) {
				counters[type] = (counters[type] ?? 0) + 1;
				shared = `[${type}_${counters[type]}]`;
				rawToToken.set(key, shared);
				map.set(shared, raw);
			}
			if (shared !== localToken) {
				rewritten = replaceAll(rewritten, localToken, shared);
			}
		}
		out.push({ ...msg, content: rewritten });
	}

	return { messages: out, map, count: map.size };
}

// ============================================
// De-anonymize
// ============================================

/**
 * Restore real values from a pseudonymized string using the per-request map.
 * Replaces longest tokens first so `[PERSON_10]` is not clobbered by
 * `[PERSON_1]`.
 */
export function deanonymize(text: string, map: Map<string, string>): string {
	if (!text || map.size === 0) return text;
	let out = text;
	const tokens = [...map.keys()].sort((a, b) => b.length - a.length);
	for (const token of tokens) {
		out = replaceAll(out, token, map.get(token) ?? token);
	}
	return out;
}

// ============================================
// Verification (fail-closed support)
// ============================================

/**
 * True if `text` still contains any value the anonymizer recognizes as PII.
 * Used both to drive fail-closed routing and to assert the outbound payload
 * is clean after anonymization. Because the detectors are the same ones used
 * to mask, a clean payload here means "nothing the gate can see survived".
 */
export function containsPii(text: string): boolean {
	if (!text) return false;
	for (const { value } of [...OWNER_IDENTITY, ...runtimeOwnerIdentity]) {
		if (value.length >= 2 && text.includes(value)) return true;
	}
	for (const tok of [...OWNER_NAME_TOKENS, ...runtimeOwnerTokens]) {
		if (new RegExp(`\\b${escapeRegExp(tok)}\\b`).test(text)) return true;
	}
	for (const det of DETECTORS) {
		det.re.lastIndex = 0;
		for (let m = det.re.exec(text); m; m = det.re.exec(text)) {
			if (!det.accept || det.accept(m[0])) return true;
		}
	}
	return false;
}

/**
 * Assert an outbound (already-anonymized) payload is clean. Returns true when
 * NO PII remains. The egress chokepoint calls this after anonymizing and
 * BEFORE sending; a false result means "do not send to cloud - fail closed".
 */
export function verifyClean(text: string): boolean {
	return !containsPii(text);
}

// ============================================
// Helpers
// ============================================

function collectLiteral(text: string, literal: string, type: PiiType, spans: Span[]): void {
	if (!literal || literal.length < 2) return;
	const re = new RegExp(escapeRegExp(literal), "gi");
	for (let m = re.exec(text); m; m = re.exec(text)) {
		spans.push({
			start: m.index,
			end: m.index + m[0].length,
			type,
			raw: m[0],
			priority: OWNER_PRIORITY,
		});
	}
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceAll(haystack: string, needle: string, replacement: string): string {
	return haystack.split(needle).join(replacement);
}
