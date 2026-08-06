/**
 * 8gent Huddle Phase 1 - the SlideSpec: what an officer emits INSTEAD of prose.
 *
 * Spec: docs/8GENT-HUDDLE-SPEC.md section 4.
 *
 * The whole point, in one sentence: an officer names an INTENT, a LAYOUT, and
 * CLAIM REFERENCES; code composes the pixels. That is what makes a slide both
 * cheap (a slide costs ~40 tokens instead of ~200 of prose) and trustworthy (no
 * number on a slide was authored by a model).
 *
 * This module is the same marker family as [[TASK]] / [[HELM]] / [[CLAIM]]:
 *
 *   [[SLIDE {"layout":"metric","heading":"Backup verify is clean",
 *            "metric":{"value":"[[CLAIM src=dir.count path=... ]]","label":"..."}}]]
 *
 * It is JSON DATA. Not markup, not code, not a URL. Validation is TOTAL: any
 * unknown key, any oversize field, any wrong type, any layout outside the
 * closed enum, and the spec is rejected in favour of a deterministic fallback
 * derived from the officer's own reply text. A malformed spec never blocks the
 * floor and never renders an error slide (spec 4.2).
 *
 * NOTE ON CLAIM REFERENCES (the honesty rule, spec 4.2 + the verify substrate):
 * a SlideSpec string field MAY contain a [[CLAIM ...]] marker. The daemon runs
 * packages/verify's processClaims over the spec's TEXT FIELDS before rendering,
 * so the renderer only ever sees resolved values. A field whose claim failed to
 * verify is not silently dropped - it carries an ASSERTED flag through to the
 * renderer, which marks it visibly on the slide. See slide-render.ts.
 */

// ── The closed schema (spec 4.2) ───────────────────────────────────────────

export const LAYOUTS = ["cover", "bullets", "metric", "quote", "compare", "code", "timeline", "close"] as const;
export type Layout = (typeof LAYOUTS)[number];

export const CODE_LANGS = ["bash", "ts", "py", "json", "sql"] as const;
export type CodeLang = (typeof CODE_LANGS)[number];

export interface SlideSpec {
	layout: Layout;
	heading: string;
	bullets?: string[];
	metric?: { value: string; label: string };
	quote?: { text: string; attribution?: string };
	compare?: { left: string; right: string };
	timeline?: string[];
	code?: { lang: CodeLang; text: string };
	/** Presenter note. Never rendered onto the slide. */
	note?: string;
}

/** Field limits, exactly as declared in spec 4.2. Exported so tests assert on
 *  the same constants the validator uses rather than restating them. */
export const LIMITS = {
	heading: 60,
	bullets: 5,
	bulletChars: 48,
	metricValue: 12,
	metricLabel: 40,
	quoteText: 180,
	quoteAttribution: 60,
	compareSide: 48,
	timeline: 5,
	timelineChars: 40,
	codeChars: 400,
	note: 200,
} as const;

/** Every key the schema permits. Anything else rejects the whole spec. */
const ALLOWED_KEYS = new Set(["layout", "heading", "bullets", "metric", "quote", "compare", "timeline", "code", "note"]);

// ── Marker parsing ─────────────────────────────────────────────────────────

/**
 * A [[SLIDE {json}]] marker. Unlike [[CLAIM]]'s k=v grammar, the payload is a
 * JSON object, so the terminator has to be matched by brace-depth rather than
 * by a lazy regex - a `]]` can legally appear inside a JSON string value.
 *
 * Returns the raw marker text and its JSON body, or null when no marker is
 * present. Only the FIRST marker is honoured (spec 4.1: "exactly one marker").
 */
export function findSlideMarker(reply: string): { raw: string; json: string } | null {
	const open = reply.indexOf("[[SLIDE");
	if (open === -1) return null;
	const bodyStartRaw = reply.indexOf("{", open);
	if (bodyStartRaw === -1) return null;

	// A doubled quote (`""text"`) must be repaired BEFORE the brace scan, not
	// after: it desynchronises string tracking, so every brace after it is
	// counted with inverted in-string state and the object never appears to
	// close. Repairing quotes first is what makes the scan trustworthy.
	const prefix = reply.slice(0, bodyStartRaw);
	const repairedTail = repairQuotes(reply.slice(bodyStartRaw));
	reply = prefix + repairedTail;
	const bodyStart = bodyStartRaw;

	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = bodyStart; i < reply.length; i++) {
		const ch = reply[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				const json = reply.slice(bodyStart, i + 1);
				// Swallow the marker's trailing punctuation. Local 9-12B models
				// routinely emit "}}]" or "}]" or "}]]" - the same early-closed and
				// over-closed bracket salvage as helm-bridge's parseProposal. Leaving
				// residue behind would put "}]" into the officer's SPOKEN line.
				const after = reply.slice(i + 1);
				let closeLen = /^[\s}\]]*/.exec(after)?.[0].length ?? 0;
				// A model that closed the object early sometimes carries on with more
				// payload before the real "]]" (`...]},"metric":{...}]]`). Swallow
				// through that terminator too, but only on the same line and only
				// within a short window, so a "]]" in later prose is never eaten.
				const tailMatch = /^[^\n]{0,240}?\]\]/.exec(after);
				if (tailMatch && tailMatch[0].length > closeLen) closeLen = tailMatch[0].length;
				return { raw: reply.slice(open, i + 1 + closeLen), json };
			}
		}
	}

	// Unterminated: the model ran out of tokens mid-marker. Salvage by closing
	// whatever is still open, in reverse order. A truncated slide is still a
	// better slide than a paragraph of JSON read aloud as if it were speech.
	const tail = reply.slice(bodyStart);
	const stack: string[] = [];
	inString = false;
	escaped = false;
	for (const ch of tail) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") stack.push("}");
		else if (ch === "[") stack.push("]");
		else if (ch === "}" || ch === "]") stack.pop();
	}
	// Drop a dangling "key": or trailing comma before closing, so the salvage
	// is valid JSON rather than merely balanced.
	let salvaged = tail.replace(/,\s*$/, "").replace(/,?\s*"[^"]*"\s*:\s*$/, "");
	if (inString) salvaged += '"';
	salvaged += stack.reverse().join("");
	return { raw: reply.slice(open), json: salvaged };
}

/**
 * Remove the slide marker from a reply, leaving only the speakable prose.
 *
 * Deliberately positional rather than a `replace(found.raw, "")`: the repair
 * pass rewrites the marker body, so the recovered `raw` no longer matches the
 * original text byte for byte, and a string replace silently leaves fragments
 * of JSON behind - which the narrator would then READ ALOUD. Cutting from
 * `[[SLIDE` to the marker's terminator cannot leave residue no matter how
 * malformed the marker was.
 *
 * Spec 4.1 puts the marker at the END of the reply, so anything after the
 * terminator is kept (a model that keeps talking is not silenced), and a marker
 * with no terminator at all takes the rest of the string with it.
 */
export function stripSlideMarker(reply: string): string {
	const open = reply.indexOf("[[SLIDE");
	if (open === -1) return reply.trim();
	const before = reply.slice(0, open);
	const rest = reply.slice(open);
	const close = rest.indexOf("]]");
	// Over-closed markers ("]]]" / "}]]") leave a stray bracket after the
	// terminator. Swallow those too, or the narrator reads a bracket aloud.
	const after = close === -1 ? "" : rest.slice(close + 2).replace(/^[\s\]}]+/, "");
	return `${before}${after}`.replace(/\n{3,}/g, "\n\n").trim();
}

export function hasSlideMarker(reply: string): boolean {
	return findSlideMarker(reply) !== null;
}

/**
 * Repair the almost-JSON a 9-12B local model actually emits.
 *
 * MEASURED failure modes, all from the officers' real model on real huddle
 * turns, all of which carried perfectly good CONTENT behind a punctuation
 * defect:
 *
 *   ["a",""b","c"]        a doubled opening quote on an array element
 *   {"a":1,}              a trailing comma
 *   {"a":"b",}}}          over-closed braces (handled by the brace scanner)
 *   {"a":'b'}             single quotes
 *   {"a":"b" "c":"d"}     a missing comma between pairs
 *
 * This is the same salvage philosophy the codebase already applies to [[HELM]]
 * and [[CLAIM]]: rigor belongs in the checker, not the punctuation. Every
 * repaired spec still goes through the full, total validator afterwards, so a
 * repair can never smuggle an invalid slide through - at worst it turns an
 * unparseable string into a parseable one that the validator then rejects.
 */
/**
 * The quote half of the repair, split out because it must run BEFORE the
 * brace scan (a doubled quote inverts in-string state and hides the closing
 * brace) as well as as part of the full repair.
 */
export function repairQuotes(json: string): string {
	return (
		json
			// A doubled quote where a string should OPEN (after "[", "," or ":").
			.replace(/([[,:]\s*)""(?=[^"\]},])/g, '$1"')
			// A doubled quote where a string should CLOSE (before "]", "}" or ",").
			.replace(/([^"[{,:\s])""(?=\s*[\]},])/g, '$1"')
	);
}

export function repairJson(json: string): string {
	let s = repairQuotes(json);

	// Single-quoted strings, only when they contain no double quote themselves.
	s = s.replace(/'([^'"]*)'/g, '"$1"');
	// A missing comma between two pairs: "a":"b" "c":"d"
	s = s.replace(/"(\s*)"(?=[A-Za-z_][A-Za-z0-9_]*"\s*:)/g, '",$1"');
	// Trailing commas.
	s = s.replace(/,(\s*[}\]])/g, "$1");

	return s;
}

/** Parse a marker body, repairing it once if the first attempt fails. */
function parseMarkerJson(json: string): { ok: true; value: unknown } | { ok: false; reason: string } {
	try {
		return { ok: true, value: JSON.parse(json) };
	} catch {
		// fall through to the repair attempt
	}
	try {
		return { ok: true, value: JSON.parse(repairJson(json)) };
	} catch (err) {
		return { ok: false, reason: `invalid JSON: ${(err as Error).message}` };
	}
}

// ── Validation (total, spec 4.2) ───────────────────────────────────────────

export interface ValidationResult {
	ok: boolean;
	spec?: SlideSpec;
	/** Why it was rejected. Recorded in the manifest, never rendered as a slide. */
	reason?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True when a field carries a claim REFERENCE rather than a literal value. */
function hasClaimRef(s: string): boolean {
	return /\[\[(?:CLAIM|DERIVE)\s/.test(s);
}

/**
 * A string field: right type, non-empty after trim, brought within its cap.
 *
 * TWO DELIBERATE DEVIATIONS from spec 4.2, both because rejecting here loses a
 * good slide to a punctuation-grade problem, and both consistent with the
 * tolerance philosophy this codebase already applies to [[HELM]] and [[CLAIM]]
 * ("the CHECKER is where rigor lives, not the punctuation"):
 *
 *  1. An oversize string is CLIPPED, not rejected. Measured on the real
 *     officer model: a 49-character bullet is the single most common validation
 *     failure, and throwing away an otherwise perfect five-bullet slide over one
 *     character is a worse outcome than an ellipsis.
 *  2. A field containing a claim REFERENCE is exempt from the cap. The cap
 *     governs the RESOLVED value, and `[[CLAIM src=git.head repo=...]]` is 30+
 *     characters that resolve to a short hash. Measuring the reference against
 *     the value's budget rejected every correctly-authored metric slide.
 *
 * Type errors, empty fields, unknown keys and bad enums still reject. Rigor is
 * kept where it protects the render; tolerance is applied where it only
 * protects punctuation.
 */
function str(v: unknown, cap: number, field: string): { ok: true; value: string } | { ok: false; reason: string } {
	if (typeof v !== "string") return { ok: false, reason: `${field} must be a string` };
	const t = v.trim();
	if (!t) return { ok: false, reason: `${field} must not be empty` };
	if (hasClaimRef(t)) return { ok: true, value: t };
	return { ok: true, value: t.length > cap ? clip(t, cap) : t };
}

function strArray(
	v: unknown,
	maxItems: number,
	cap: number,
	field: string,
): { ok: true; value: string[] } | { ok: false; reason: string } {
	// A model that produced one bullet often emits it as a bare string.
	const arr = typeof v === "string" ? [v] : v;
	if (!Array.isArray(arr)) return { ok: false, reason: `${field} must be an array` };
	const items = arr.filter((x) => !(typeof x === "string" && !x.trim()));
	if (items.length === 0) return { ok: false, reason: `${field} must not be empty` };
	const out: string[] = [];
	for (let i = 0; i < Math.min(items.length, maxItems); i++) {
		const r = str(items[i], cap, `${field}[${i}]`);
		if (!r.ok) return r;
		out.push(r.value);
	}
	return { ok: true, value: out };
}

/**
 * Fold model-flattened shapes back into the schema BEFORE validation.
 *
 * Measured behaviour of the officers' real 12B model: it reliably picks the
 * right layout and the right content, then writes the payload at the top level
 * instead of nesting it - `{"layout":"compare","left":...,"right":...}` rather
 * than `{"layout":"compare","compare":{"left":...,"right":...}}`. That is a
 * shape error, not a content error, and it is deterministic to repair.
 *
 * Only keys that are unambiguous for the DECLARED layout are lifted, so this
 * can never invent a payload the officer did not write. Anything left unknown
 * after this pass still rejects.
 */
export function normalizeSpecShape(input: Record<string, unknown>): Record<string, unknown> {
	const out = { ...input };
	const layout = typeof out.layout === "string" ? out.layout : "";

	const lift = (target: string, keys: string[]) => {
		if (out[target] !== undefined) return; // officer nested it correctly
		const nested: Record<string, unknown> = {};
		let found = false;
		for (const k of keys) {
			if (out[k] !== undefined) {
				nested[k] = out[k];
				delete out[k];
				found = true;
			}
		}
		if (found) out[target] = nested;
	};

	if (layout === "compare") lift("compare", ["left", "right"]);
	if (layout === "metric") lift("metric", ["value", "label"]);
	if (layout === "quote") lift("quote", ["text", "attribution"]);
	if (layout === "code") lift("code", ["lang", "text"]);

	// "items" / "points" / "steps" are the recurring synonyms for a list.
	const listKey = layout === "timeline" ? "timeline" : "bullets";
	if (out[listKey] === undefined) {
		for (const alias of ["items", "points", "steps", "list"]) {
			if (out[alias] !== undefined) {
				out[listKey] = out[alias];
				delete out[alias];
				break;
			}
		}
	}
	for (const alias of ["items", "points", "steps", "list"]) delete out[alias];

	// A "title" is always a heading.
	if (out.heading === undefined && typeof out.title === "string") out.heading = out.title;
	delete out.title;

	// MEASURED: on a "what is missing" question the model reliably builds a rich
	// two-column compare - {"compare":{"left":{"heading":..,"bullets":[..]}}} -
	// with NO top-level heading at all. The intent (this side versus that side)
	// is exactly what the compare layout is for; only the shape is wrong. Fold
	// each side down to a single string so the closed schema still holds.
	const side = (v: unknown): string | undefined => {
		if (typeof v === "string") return v;
		if (!isPlainObject(v)) return undefined;
		if (typeof v.heading === "string" && v.heading.trim()) return v.heading;
		if (typeof v.title === "string" && v.title.trim()) return v.title;
		const list = v.bullets ?? v.items;
		if (Array.isArray(list)) {
			const parts = list.filter((x): x is string => typeof x === "string" && !!x.trim());
			if (parts.length) return parts.join(", ");
		}
		if (typeof v.text === "string" && v.text.trim()) return v.text;
		return undefined;
	};
	if (isPlainObject(out.compare)) {
		const left = side(out.compare.left);
		const right = side(out.compare.right);
		if (left !== undefined && right !== undefined) out.compare = { left, right };
	}

	// A heading is REQUIRED by the schema but is the field a model most often
	// forgets when it nests everything. Deriving one from content the officer
	// did write is strictly better than throwing the whole slide away: the
	// alternative is a fallback slide built from prose, which is worse.
	if (typeof out.heading !== "string" || !out.heading.trim()) {
		let derived: string | undefined;
		if (isPlainObject(out.compare) && typeof out.compare.left === "string" && typeof out.compare.right === "string") {
			derived = `${out.compare.left} vs ${out.compare.right}`;
		}
		if (!derived && isPlainObject(out.metric) && typeof out.metric.label === "string") derived = out.metric.label;
		if (!derived && isPlainObject(out.quote) && typeof out.quote.text === "string") derived = out.quote.text;
		if (!derived) {
			const list = (out.bullets ?? out.timeline) as unknown;
			if (Array.isArray(list) && typeof list[0] === "string") derived = list[0];
		}
		if (derived) out.heading = clip(derived, LIMITS.heading);
	}

	return out;
}

/**
 * Validate an unknown parsed JSON value into a SlideSpec. Total: every reject
 * path names its own reason, and no partially-valid spec is ever returned.
 */
export function validateSlideSpec(raw: unknown): ValidationResult {
	if (!isPlainObject(raw)) return { ok: false, reason: "spec must be a JSON object" };
	const input = normalizeSpecShape(raw);

	for (const k of Object.keys(input)) {
		if (!ALLOWED_KEYS.has(k)) return { ok: false, reason: `unknown key "${k}"` };
	}

	const layout = input.layout;
	if (typeof layout !== "string" || !(LAYOUTS as readonly string[]).includes(layout)) {
		return { ok: false, reason: `layout must be one of ${LAYOUTS.join("|")}` };
	}

	const heading = str(input.heading, LIMITS.heading, "heading");
	if (!heading.ok) return { ok: false, reason: heading.reason };

	const spec: SlideSpec = { layout: layout as Layout, heading: heading.value };

	if (input.bullets !== undefined) {
		const r = strArray(input.bullets, LIMITS.bullets, LIMITS.bulletChars, "bullets");
		if (!r.ok) return { ok: false, reason: r.reason };
		spec.bullets = r.value;
	}

	if (input.metric !== undefined) {
		if (!isPlainObject(input.metric)) return { ok: false, reason: "metric must be an object" };
		for (const k of Object.keys(input.metric)) {
			if (k !== "value" && k !== "label") return { ok: false, reason: `unknown metric key "${k}"` };
		}
		const value = str(input.metric.value, LIMITS.metricValue, "metric.value");
		if (!value.ok) return { ok: false, reason: value.reason };
		const label = str(input.metric.label, LIMITS.metricLabel, "metric.label");
		if (!label.ok) return { ok: false, reason: label.reason };
		spec.metric = { value: value.value, label: label.value };
	}

	if (input.quote !== undefined) {
		if (!isPlainObject(input.quote)) return { ok: false, reason: "quote must be an object" };
		for (const k of Object.keys(input.quote)) {
			if (k !== "text" && k !== "attribution") return { ok: false, reason: `unknown quote key "${k}"` };
		}
		const text = str(input.quote.text, LIMITS.quoteText, "quote.text");
		if (!text.ok) return { ok: false, reason: text.reason };
		spec.quote = { text: text.value };
		if (input.quote.attribution !== undefined) {
			const attribution = str(input.quote.attribution, LIMITS.quoteAttribution, "quote.attribution");
			if (!attribution.ok) return { ok: false, reason: attribution.reason };
			spec.quote.attribution = attribution.value;
		}
	}

	if (input.compare !== undefined) {
		if (!isPlainObject(input.compare)) return { ok: false, reason: "compare must be an object" };
		for (const k of Object.keys(input.compare)) {
			if (k !== "left" && k !== "right") return { ok: false, reason: `unknown compare key "${k}"` };
		}
		const left = str(input.compare.left, LIMITS.compareSide, "compare.left");
		if (!left.ok) return { ok: false, reason: left.reason };
		const right = str(input.compare.right, LIMITS.compareSide, "compare.right");
		if (!right.ok) return { ok: false, reason: right.reason };
		spec.compare = { left: left.value, right: right.value };
	}

	if (input.timeline !== undefined) {
		const r = strArray(input.timeline, LIMITS.timeline, LIMITS.timelineChars, "timeline");
		if (!r.ok) return { ok: false, reason: r.reason };
		spec.timeline = r.value;
	}

	if (input.code !== undefined) {
		if (!isPlainObject(input.code)) return { ok: false, reason: "code must be an object" };
		for (const k of Object.keys(input.code)) {
			if (k !== "lang" && k !== "text") return { ok: false, reason: `unknown code key "${k}"` };
		}
		if (typeof input.code.lang !== "string" || !(CODE_LANGS as readonly string[]).includes(input.code.lang)) {
			return { ok: false, reason: `code.lang must be one of ${CODE_LANGS.join("|")}` };
		}
		const text = str(input.code.text, LIMITS.codeChars, "code.text");
		if (!text.ok) return { ok: false, reason: text.reason };
		spec.code = { lang: input.code.lang as CodeLang, text: text.value };
	}

	if (input.note !== undefined) {
		const r = str(input.note, LIMITS.note, "note");
		if (!r.ok) return { ok: false, reason: r.reason };
		spec.note = r.value;
	}

	// A layout must carry the payload it exists to display. A "metric" slide
	// with no metric is not a rendering edge case, it is a rejected spec that
	// falls back to bullets derived from the officer's own words.
	const required: Partial<Record<Layout, keyof SlideSpec>> = {
		metric: "metric",
		quote: "quote",
		compare: "compare",
		code: "code",
		timeline: "timeline",
	};
	const need = required[spec.layout];
	if (need && spec[need] === undefined) {
		return { ok: false, reason: `layout "${spec.layout}" requires a "${need}" field` };
	}

	return { ok: true, spec };
}

// ── The deterministic fallback (spec 4.2) ──────────────────────────────────

/** Sentence-ish split that does not need a locale or a tokenizer. */
function sentences(text: string): string[] {
	return text
		.replace(/\s+/g, " ")
		.split(/(?<=[.!?])\s+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Hard truncate at a word boundary where possible, with an ellipsis. */
export function clip(text: string, cap: number): string {
	const t = text.trim().replace(/\s+/g, " ");
	if (t.length <= cap) return t;
	const cut = t.slice(0, cap - 1);
	const sp = cut.lastIndexOf(" ");
	return `${(sp > cap * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/**
 * Derive a slide from the officer's own reply text. Used when no marker was
 * emitted at all, or when the marker failed validation. Pure: same text in,
 * same spec out, no clock, no randomness.
 */
export function fallbackSpecFromText(text: string): SlideSpec {
	const parts = sentences(text);
	const heading = clip(parts[0] ?? "Update", LIMITS.heading);
	const bullets = parts.slice(1, 4).map((s) => clip(s, LIMITS.bulletChars));
	return bullets.length > 0 ? { layout: "bullets", heading, bullets } : { layout: "cover", heading };
}

// ── The one entry point the daemon calls ───────────────────────────────────

export interface ResolvedSlide {
	spec: SlideSpec;
	/** "marker" when the officer's own validated spec was used. */
	source: "marker" | "fallback";
	/** Present when source is "fallback" AND a marker existed but was rejected. */
	rejectedReason?: string;
	/** The reply with the marker removed - this is what gets spoken and posted. */
	speech: string;
}

/**
 * Parse an officer reply into (slide, speech). Never throws, never returns an
 * error slide, never blocks the floor - a bad marker degrades to a fallback
 * built from the officer's own prose.
 */
export function resolveSlide(reply: string): ResolvedSlide {
	const speech = stripSlideMarker(reply);
	const found = findSlideMarker(reply);
	if (!found) return { spec: fallbackSpecFromText(speech), source: "fallback", speech };

	const parsed = parseMarkerJson(found.json);
	if (!parsed.ok) {
		return { spec: fallbackSpecFromText(speech), source: "fallback", rejectedReason: parsed.reason, speech };
	}

	const result = validateSlideSpec(parsed.value);
	if (!result.ok || !result.spec) {
		return { spec: fallbackSpecFromText(speech), source: "fallback", rejectedReason: result.reason, speech };
	}
	return { spec: result.spec, source: "marker", speech };
}

// ── The officer-facing prompt (same voice as OFFICER_CLAIM_PROMPT) ─────────

/**
 * MEASURED BEHAVIOUR, and why this prompt is shaped the way it is: the first
 * version of this text used a realistic worked example ("Backup verify is
 * clean" / "truncated dumps accepted"). All three officers on the real 12B
 * model COPIED THAT EXAMPLE VERBATIM onto their slides, regardless of topic -
 * producing a slide whose heading was about backups during a huddle about the
 * stage, and a commit hash labelled as a count of truncated dumps. A plausible
 * example is an attractive nuisance for a small model.
 *
 * So the example below is deliberately SHAPED but not PLAUSIBLE: the field
 * values are obvious placeholders that no officer could mistake for content,
 * and the instruction to replace them is explicit. Structure is taught; content
 * is not suggested.
 */
export const OFFICER_SLIDE_PROMPT = [
	"You are speaking on a live stage. End your reply with ONE slide marker. Do",
	"not describe your slide in prose - the marker IS the slide, and the system",
	"renders it. Keep your prose to what you would SAY out loud.",
	"",
	"SHAPE (replace every CAPS placeholder with YOUR OWN words about THIS topic;",
	"never copy the placeholder text itself). Put it ALL ON ONE LINE:",
	'  [[SLIDE {"layout":"bullets","heading":"YOUR POINT","bullets":["FIRST","SECOND"]}]]',
	"Strict JSON: double quotes only, one comma between items, no trailing comma.",
	"",
	"Layouts: cover, bullets, metric, quote, compare, code, timeline, close.",
	"Fields: heading (<=60 chars, required); bullets (<=5, each <=48);",
	"metric {value <=12, label <=40}; quote {text <=180, attribution};",
	"compare {left, right}; timeline (<=5, each <=40); code {lang, text}.",
	"Pick the layout that fits what you are actually saying. Your slide must",
	"restate YOUR point, not the shape above and not another officer's point.",
	"",
	"NEVER write a number, hash, count or branch name into a slide field",
	"yourself. Put a claim marker in the field and code resolves it, and make",
	"sure the label describes what that claim actually returns:",
	'  "metric":{"value":"[[CLAIM src=git.head repo=REPO_PATH]]","label":"current head"}',
	"An unverified value is marked ASSERTED on screen, so only claim what you",
	"can source. If you have no number worth showing, use layout bullets and",
	"claim nothing - an honest bullet beats a decorative metric.",
	"A malformed marker is discarded and a slide is built from your own words",
	"instead, so a bad marker costs you the slide, never the turn.",
].join("\n");
