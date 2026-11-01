/**
 * 8gent Huddle Phase 1 - resolving claim references inside a SlideSpec.
 *
 * This is the join between packages/verify (officers write REFERENCES, code
 * writes VALUES) and the slide renderer. It is what makes a deck trustworthy:
 *
 *   NO NUMBER ON A SLIDE WAS EVER AUTHORED BY A MODEL.
 *
 * The officer writes a field like
 *   "metric": { "value": "[[CLAIM src=git.head repo=~/8gent-code]]", ... }
 * and this module replaces it with the deterministically resolved value.
 *
 * WHY NOT JUST CALL processClaims ON THE WHOLE REPLY: its `rendered` form is
 * prose designed for a chat message - `13 (verified: file.lines path=...)`.
 * That is correct for a channel post and impossible for a 12-character metric
 * field. So we reuse the exact same resolution machinery (parseMarkers +
 * processClaims, one field at a time) and take the BARE value, then carry the
 * verification status out-of-band as `assertedFields` for the renderer to mark.
 * Resolution logic is not duplicated; only the presentation differs.
 *
 * HONESTY RULE (non-negotiable): a field whose claim did not verify is NOT
 * dropped and NOT stated flatly. The officer's asserted text stays visible and
 * the field is added to `assertedFields`, so renderSlide stamps a visible
 * ASSERTED chip on it. Unverified never looks like verified.
 */

import { hasClaimMarkers, processClaims, type LedgerLike, type ClaimResult } from "../verify";
import { clip, LIMITS, type SlideSpec } from "./slide-spec";

export interface SlideVerifyOptions {
	roots?: string[];
	ledger?: LedgerLike;
	now?: () => number;
}

export interface SlideVerifyOutcome {
	/** The spec with every resolvable reference replaced by its real value. */
	spec: SlideSpec;
	/** Dotted field paths whose value is officer-asserted, not verified. */
	assertedFields: string[];
	/** Every claim result, for the manifest and the ledger trail. */
	results: ClaimResult[];
}

/** Resolve one field. Returns the value to render plus whether it is verified. */
function resolveField(
	raw: string,
	cap: number,
	opts: SlideVerifyOptions,
	collect: ClaimResult[],
): { value: string; verified: boolean } {
	if (!hasClaimMarkers(raw)) {
		// No reference at all. The officer wrote plain descriptive text. That is
		// allowed for labels and headings, but it is not a verified fact, so it
		// is reported as such only when it LOOKS like a fact (see below).
		return { value: raw, verified: true };
	}

	const outcome = processClaims(raw, opts);
	collect.push(...outcome.results);

	// One marker occupying the whole field is the common, intended shape - swap
	// in the bare value so it fits the field's character budget.
	const single = outcome.results.length === 1 ? outcome.results[0] : undefined;
	if (single && single.status === "verified" && single.value !== undefined) {
		const onlyMarker = raw.trim().startsWith("[[") && raw.trim().endsWith("]]");
		return { value: clip(onlyMarker ? single.value : outcome.text, cap), verified: true };
	}

	if (outcome.allVerified && outcome.results.length > 0) {
		return { value: clip(outcome.text, cap), verified: true };
	}

	// Something failed. Prefer the officer's own asserted value when they gave
	// one (expect=), because showing "0" flagged ASSERTED is more useful to
	// James than showing "[CLAIM STRIPPED: ...]" on a slide. When they asserted
	// nothing there is genuinely nothing to show, so the field reads "unknown"
	// and is still flagged.
	const asserted = outcome.results.find((r) => r.expect !== undefined)?.expect;
	return { value: clip(asserted ?? "unknown", cap), verified: false };
}

/**
 * Resolve every claim reference in a SlideSpec's text fields.
 *
 * Deterministic over its inputs plus the real repo state the references point
 * at. Fields with no reference pass through untouched.
 */
export function verifySlideSpec(spec: SlideSpec, opts: SlideVerifyOptions = {}): SlideVerifyOutcome {
	const asserted: string[] = [];
	const results: ClaimResult[] = [];
	const out: SlideSpec = { layout: spec.layout, heading: spec.heading };

	const take = (raw: string, cap: number, path: string): string => {
		const r = resolveField(raw, cap, opts, results);
		if (!r.verified) asserted.push(path);
		return r.value;
	};

	out.heading = take(spec.heading, LIMITS.heading, "heading");

	if (spec.bullets) {
		out.bullets = spec.bullets.map((b, i) => take(b, LIMITS.bulletChars, `bullets.${i}`));
	}
	if (spec.metric) {
		out.metric = {
			value: take(spec.metric.value, LIMITS.metricValue, "metric.value"),
			label: take(spec.metric.label, LIMITS.metricLabel, "metric.label"),
		};
	}
	if (spec.quote) {
		out.quote = { text: take(spec.quote.text, LIMITS.quoteText, "quote.text") };
		if (spec.quote.attribution !== undefined) out.quote.attribution = spec.quote.attribution;
	}
	if (spec.compare) {
		out.compare = {
			left: take(spec.compare.left, LIMITS.compareSide, "compare.left"),
			right: take(spec.compare.right, LIMITS.compareSide, "compare.right"),
		};
	}
	if (spec.timeline) {
		out.timeline = spec.timeline.map((t, i) => take(t, LIMITS.timelineChars, `timeline.${i}`));
	}
	// Code text is shown verbatim. A claim marker inside a code block is not
	// resolved: substituting into code the officer is quoting would change the
	// meaning of the quote.
	if (spec.code) out.code = { ...spec.code };
	if (spec.note !== undefined) out.note = spec.note;

	return { spec: out, assertedFields: asserted, results };
}
