/**
 * 8gent Huddle Phase 1 - zen-gen (spec section 6).
 *
 * James dictates. The system generates slides that accompany playback of HIS
 * OWN recorded voice, with visuals matching, at ZERO LLM token cost.
 *
 * The "almost zero tokens" claim, made literal: no LLM is invoked anywhere in
 * this file. Every function here is a pure function of whisper's segment list.
 * The only model in the pipeline is whisper.cpp ggml-base.en (74M params, an
 * on-device ASR model, not an LLM, no context window, not billed).
 *
 * His wav is the playback audio. It is never re-synthesised - it is his voice,
 * not a clone of it. Slide k is shown at [t0_k, t1_k] taken from whisper's OWN
 * timestamps against that same audio, so sync is exact by construction rather
 * than estimated.
 */

import { LIMITS, type Layout, type SlideSpec, clip } from "./slide-spec";

/** One whisper segment. Whisper's JSON carries offsets in milliseconds. */
export interface Segment {
	/** Start offset in ms from the beginning of the recording. */
	t0: number;
	/** End offset in ms. */
	t1: number;
	text: string;
}

/** A contiguous run of segments that becomes exactly one slide. */
export interface Beat {
	t0: number;
	t1: number;
	text: string;
	segments: Segment[];
}

// ── 6.2 Beat segmentation (deterministic, no model) ───────────────────────

export const BEAT_HARD_CAP_MS = 20_000;
export const BEAT_SENTENCE_MIN_MS = 6_000;
export const BEAT_MARKER_MIN_MS = 4_000;
export const BEAT_PAUSE_MIN_MS = 4_000;
export const BEAT_PAUSE_GAP_MS = 900;
export const BEAT_MERGE_FLOOR_MS = 3_000;

/** R3's discourse markers. Fixed list, matched case-insensitively at a word
 *  boundary at the START of the next segment. */
export const DISCOURSE_MARKERS = [
	"so",
	"now",
	"next",
	"but",
	"however",
	"first",
	"second",
	"third",
	"finally",
	"the point is",
	"look",
	"right",
] as const;

function startsWithMarker(text: string): boolean {
	const t = text.trim().toLowerCase();
	return DISCOURSE_MARKERS.some((m) => t === m || t.startsWith(`${m} `) || t.startsWith(`${m},`));
}

function endsSentence(text: string): boolean {
	return /[.!?]["')\]]?\s*$/.test(text.trim());
}

/**
 * Accumulate segments into beats. Rules are evaluated in fixed order R1..R4, so
 * the output is a pure function of the input: same dictation, same beats, every
 * time.
 *
 *   R1 hard cap        accumulated >= 20.0s
 *   R2 sentence end    segment ends in . ? !  AND accumulated >= 6.0s
 *   R3 discourse       next segment starts with a marker AND accumulated >= 4.0s
 *   R4 long pause      gap to next >= 0.9s AND accumulated >= 4.0s
 *
 * Then a merge pass: any beat shorter than 3.0s merges forward into its
 * successor, or backward when it is the last beat.
 */
export function segmentBeats(segments: readonly Segment[]): Beat[] {
	const usable = segments.filter((s) => s.text.trim().length > 0);
	if (usable.length === 0) return [];

	const beats: Beat[] = [];
	let current: Segment[] = [];

	const flush = () => {
		if (current.length === 0) return;
		beats.push({
			t0: current[0].t0,
			t1: current[current.length - 1].t1,
			text: current.map((s) => s.text.trim()).join(" ").replace(/\s+/g, " ").trim(),
			segments: current,
		});
		current = [];
	};

	for (let i = 0; i < usable.length; i++) {
		const seg = usable[i];
		current.push(seg);
		const accumulated = seg.t1 - current[0].t0;
		const next = usable[i + 1];

		if (accumulated >= BEAT_HARD_CAP_MS) {
			flush();
			continue;
		}
		if (endsSentence(seg.text) && accumulated >= BEAT_SENTENCE_MIN_MS) {
			flush();
			continue;
		}
		if (next && startsWithMarker(next.text) && accumulated >= BEAT_MARKER_MIN_MS) {
			flush();
			continue;
		}
		if (next && next.t0 - seg.t1 >= BEAT_PAUSE_GAP_MS && accumulated >= BEAT_PAUSE_MIN_MS) {
			flush();
		}
	}
	flush();

	return mergeShortBeats(beats);
}

function mergeShortBeats(beats: readonly Beat[]): Beat[] {
	if (beats.length <= 1) return [...beats];
	const out: Beat[] = [];
	let carry: Beat | null = null;

	for (const beat of beats) {
		// Annotated, not inferred: `carry` is reassigned from `merged` below, so
		// inferring `merged` from `carry` is circular (TS7022).
		const merged: Beat = carry
			? {
					t0: carry.t0,
					t1: beat.t1,
					text: `${carry.text} ${beat.text}`.replace(/\s+/g, " ").trim(),
					segments: [...carry.segments, ...beat.segments],
				}
			: beat;
		carry = null;
		if (merged.t1 - merged.t0 < BEAT_MERGE_FLOOR_MS) {
			carry = merged; // too short - carry it forward into the next beat
			continue;
		}
		out.push(merged);
	}

	// A trailing short beat has no successor, so it merges BACKWARD.
	if (carry) {
		const last = out.pop();
		out.push(
			last
				? {
						t0: last.t0,
						t1: carry.t1,
						text: `${last.text} ${carry.text}`.replace(/\s+/g, " ").trim(),
						segments: [...last.segments, ...carry.segments],
					}
				: carry,
		);
	}
	return out;
}

// ── 6.3 Deterministic visual selection ────────────────────────────────────

export interface TemplateRule {
	weight: number;
	pattern: RegExp;
	layout: Layout;
}

/** Compiled-in, ordered. Highest weight wins; ties break by declaration index. */
export const TEMPLATE_RULES: readonly TemplateRule[] = [
	{ weight: 10, pattern: /\b\d+([.,]\d+)?\s*(%|percent|x|times|million|billion|k|ms|s|gb|mb)\b/i, layout: "metric" },
	{ weight: 8, pattern: /\b(versus|vs\.?|compared to|instead of|rather than|on the other hand)\b/i, layout: "compare" },
	{ weight: 7, pattern: /\b(first\b[\s\S]{0,80}\bsecond|step \d|phase \d|then we|after that)\b/i, layout: "timeline" },
	{ weight: 6, pattern: /\b(quote|as .{2,30} said|in their words)\b/i, layout: "quote" },
	{ weight: 6, pattern: /(```|\b(npx|bun|git|ffmpeg|curl|python3)\s)/i, layout: "code" },
	{ weight: 5, pattern: /^\s*(so|right|ok|okay)[,.]?\s+(here|this) is\b/i, layout: "cover" },
	{ weight: 4, pattern: /\b(to close|in summary|the ask is|so that is|bottom line)\b/i, layout: "close" },
];

export function selectLayout(text: string): Layout {
	let best: TemplateRule | null = null;
	for (const rule of TEMPLATE_RULES) {
		if (!rule.pattern.test(text)) continue;
		if (!best || rule.weight > best.weight) best = rule; // ties keep the earlier declaration
	}
	return best?.layout ?? "bullets";
}

const FILLERS = ["so", "um", "uh", "like", "you know", "basically", "right", "ok", "okay", "and"];

/** First clause, fillers stripped, <= 6 words, sentence-cased. Pure. */
export function extractHeading(text: string): string {
	let t = text.replace(/\s+/g, " ").trim();
	// Strip leading fillers repeatedly - dictation stacks them ("so, right, ok").
	let changed = true;
	while (changed) {
		changed = false;
		for (const f of FILLERS) {
			const re = new RegExp(`^${f}\\b[,.]?\\s*`, "i");
			if (re.test(t)) {
				t = t.replace(re, "");
				changed = true;
			}
		}
	}
	const clause = t.split(/[,.;]/)[0] ?? t;
	const words = clause.split(/\s+/).filter(Boolean).slice(0, 6);
	const heading = words.join(" ");
	if (!heading) return "Update";
	return clip(heading.charAt(0).toUpperCase() + heading.slice(1), LIMITS.heading);
}

/**
 * Split a beat into candidate fragments, score them, take the top 3.
 * +3 a digit, +2 a glossary token, +1 a 3-to-8 word fragment. Ties by original
 * order. Pure over (text, glossary).
 */
export function extractBullets(text: string, glossary: readonly string[] = []): string[] {
	const fragments = text
		.split(/,\s+and\s+|;\s+|\s+-\s+|(?<=[.!?])\s+/)
		.map((s) => s.trim().replace(/^[,.;\s-]+|[,;\s-]+$/g, ""))
		.filter((s) => s.split(/\s+/).filter(Boolean).length >= 2);

	const lowerGlossary = glossary.map((g) => g.toLowerCase());
	const scored = fragments.map((f, i) => {
		const words = f.split(/\s+/).filter(Boolean).length;
		let score = 0;
		if (/\d/.test(f)) score += 3;
		if (lowerGlossary.some((g) => f.toLowerCase().includes(g))) score += 2;
		if (words >= 3 && words <= 8) score += 1;
		return { f, i, score };
	});

	return scored
		.sort((a, b) => b.score - a.score || a.i - b.i)
		.slice(0, 3)
		.sort((a, b) => a.i - b.i)
		.map((s) => clip(s.f, LIMITS.bulletChars));
}

/** First weight-10 capture becomes metric.value; the next 4 words the label. */
export function extractMetric(text: string): { value: string; label: string } | null {
	const m = /\b(\d+([.,]\d+)?\s*(?:%|percent|x|times|million|billion|k|ms|s|gb|mb))\b/i.exec(text);
	if (!m) return null;
	const value = clip(m[1].replace(/\s+/g, ""), LIMITS.metricValue);
	const after = text.slice(m.index + m[0].length).trim().split(/\s+/).filter(Boolean).slice(0, 4).join(" ");
	return { value, label: clip(after || extractHeading(text), LIMITS.metricLabel) };
}

/**
 * Turn one beat into one SlideSpec. Pure, no model, no clock, no randomness.
 * Every layout falls back to bullets when its required payload cannot be
 * extracted, so this can never emit a spec that fails validation.
 */
export function specForBeat(beat: Beat, glossary: readonly string[] = []): SlideSpec {
	const text = beat.text;
	const heading = extractHeading(text);
	const bullets = extractBullets(text, glossary);
	const layout = selectLayout(text);

	switch (layout) {
		case "metric": {
			const metric = extractMetric(text);
			if (metric) return { layout: "metric", heading, metric, ...(bullets.length ? { bullets } : {}) };
			break;
		}
		case "compare": {
			const m = /^(.*?)\b(?:versus|vs\.?|compared to|instead of|rather than|on the other hand)\b(.*)$/is.exec(text);
			const left = clip((m?.[1] ?? "").trim(), LIMITS.compareSide);
			const right = clip((m?.[2] ?? "").trim(), LIMITS.compareSide);
			if (left && right) return { layout: "compare", heading, compare: { left, right } };
			break;
		}
		case "timeline": {
			if (bullets.length >= 2) return { layout: "timeline", heading, timeline: bullets.map((b) => clip(b, LIMITS.timelineChars)) };
			break;
		}
		case "quote": {
			const q = clip(text, LIMITS.quoteText);
			if (q) return { layout: "quote", heading, quote: { text: q } };
			break;
		}
		case "code": {
			const fenced = /```[a-z]*\n?([\s\S]*?)```/i.exec(text)?.[1];
			const line = /\b((?:npx|bun|git|ffmpeg|curl|python3)\s[^.!?]*)/i.exec(text)?.[1];
			const code = clip((fenced ?? line ?? "").trim(), LIMITS.codeChars);
			if (code) return { layout: "code", heading, code: { lang: "bash", text: code } };
			break;
		}
		case "cover":
			return { layout: "cover", heading };
		case "close":
			return bullets.length ? { layout: "close", heading, bullets } : { layout: "close", heading };
		case "bullets":
			break;
	}

	return bullets.length ? { layout: "bullets", heading, bullets } : { layout: "cover", heading };
}

/** A beat plus the slide it deterministically produces, keyed to real audio. */
export interface ZenSlide {
	index: number;
	t0: number;
	t1: number;
	text: string;
	spec: SlideSpec;
}

/** The whole zen-gen transform: whisper segments in, timed slides out. Pure. */
export function zenSlides(segments: readonly Segment[], glossary: readonly string[] = []): ZenSlide[] {
	return segmentBeats(segments).map((beat, index) => ({
		index,
		t0: beat.t0,
		t1: beat.t1,
		text: beat.text,
		spec: specForBeat(beat, glossary),
	}));
}

// ── whisper JSON adapter ──────────────────────────────────────────────────

/**
 * Parse whisper.cpp's `-oj` output into Segments.
 *
 * whisper.cpp writes `transcription[].offsets.{from,to}` in MILLISECONDS.
 * OpenAI-format JSON instead uses `segments[].{start,end}` in SECONDS. Both
 * shapes are accepted because both appear on this machine depending on which
 * binary produced the file, and guessing wrong silently would desynchronise
 * every slide from the audio.
 */
export function parseWhisperJson(raw: string): Segment[] {
	const data = JSON.parse(raw) as Record<string, unknown>;

	const whisperCpp = data.transcription as
		| { offsets?: { from?: number; to?: number }; text?: string }[]
		| undefined;
	if (Array.isArray(whisperCpp)) {
		return whisperCpp
			.map((s) => ({ t0: Math.round(s.offsets?.from ?? 0), t1: Math.round(s.offsets?.to ?? 0), text: String(s.text ?? "") }))
			.filter((s) => s.t1 > s.t0 && s.text.trim());
	}

	const openai = data.segments as { start?: number; end?: number; text?: string }[] | undefined;
	if (Array.isArray(openai)) {
		return openai
			.map((s) => ({ t0: Math.round((s.start ?? 0) * 1000), t1: Math.round((s.end ?? 0) * 1000), text: String(s.text ?? "") }))
			.filter((s) => s.t1 > s.t0 && s.text.trim());
	}

	return [];
}
