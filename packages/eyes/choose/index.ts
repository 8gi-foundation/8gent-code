/**
 * chooseElement: closed-option grounding.
 *
 * ground() (../ground) asks a vision model WHERE a target is and gets a
 * point back. This module is the cheaper path for screens that already
 * expose their controls (a DOM list from 8gent Browser, an AX tree from
 * packages/eyes): the candidates are lettered A..Z and the LOCAL decision
 * model (packages/decide) picks one letter. It cannot invent a target, a
 * coordinate, or typed text:
 *
 *   - typed text comes only from the caller's `inputs`; a type intent with
 *     no matching input returns NEEDS_INPUT,
 *   - low confidence or a thin top-2 margin returns NEEDS_AGENT,
 *   - risky controls (delete, send, pay ...) are hidden unless `allowRisky`,
 *   - an empty element list returns NO_NODE so the caller falls back to
 *     ground() on the screenshot.
 *
 * Concepts from arc-cua (MIT) and Cua CUA-S1 (MIT); nothing copied.
 * Refs 8gi-foundation/8gent-code#4043.
 */
import type { Decider } from "../../decide/index.js";

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** One candidate control, in whatever pixel space the source uses (CSS px for DOM, logical px for AX). */
export interface ChoiceElement {
	/** The caller's own handle: DOM enumeration index or AX row position. Returned unchanged. */
	index: number;
	/** Tag name (DOM) or AX role. */
	role: string;
	/** Visible text, aria-label, placeholder or AX label. May be empty. */
	label: string;
	rect: Rect;
	visible?: boolean;
	enabled?: boolean;
	/** AX node id, passed through for the caller. */
	id?: string;
}

export interface ChooseInput {
	elements: ChoiceElement[];
	/** Plain-language step, e.g. "click the Sign in button" or "type the email". */
	intent: string;
	/** Literal values the step may type, by name. Never shown to the model. */
	inputs?: Record<string, string>;
	allowRisky?: boolean;
	decider: Pick<Decider, "choice">;
	/** Pixel space the rects are in; derived from the rects when absent. */
	viewport?: { width: number; height: number };
}

interface Meta {
	/** Candidates shown to the model (after hiding and prefiltering). */
	candidates: number;
	/** True when more than MAX_ELEMENTS were visible and token overlap cut the list. */
	prefiltered: boolean;
	/** Risky controls hidden from the model. */
	hidden: number;
	ms: number;
	backend?: string;
	model?: string;
}

export type ChooseOutcome =
	| ({
			status: "CHOSEN";
			index: number;
			element: ChoiceElement;
			confidence: number;
			/** Top probability minus the runner-up's. */
			margin: number;
			action: "click" | "type";
			/** Present for a type action: the caller-supplied value. */
			text?: string;
	  } & Meta)
	| { status: "NEEDS_INPUT"; missing: string[] }
	| ({
			status: "NEEDS_AGENT";
			reason: string;
			confidence?: number;
			margin?: number;
			/** The pick the threshold held back. For logs and evals only; never act on it. */
			heldIndex?: number;
	  } & Partial<Meta>)
	| { status: "NO_NODE" };

/** Ollama scores one letter token, so 26 options: 25 elements plus the "none" exit. */
export const MAX_OPTIONS = 26;
export const MAX_ELEMENTS = MAX_OPTIONS - 1;
export const NONE_OPTION = "None of these: the target is not in the list";
/**
 * Keep the model's pick only when its probability clears MIN_CONFIDENCE and
 * beats the runner-up by MIN_MARGIN. Uniform over 26 options is 0.038, so
 * 0.35 means the mass has collapsed onto one letter. Fitted on the 12 Oct
 * labelled set (eval/run.ts); see the PR for the sweep.
 */
export const MIN_CONFIDENCE = 0.35;
export const MIN_MARGIN = 0.1;

export const RISKY =
	/\b(delete|remove|send|pay|purchase|buy|checkout|transfer|sign\s?out|log\s?out|unsubscribe|cancel subscription)\b/i;
const TYPE_INTENT = /\b(type|enter|fill|write|input|paste)\b/i;
const QUESTION = "Which element should be used for the task?";

export function isRisky(el: Pick<ChoiceElement, "label" | "role">): boolean {
	return RISKY.test(`${el.role} ${el.label}`);
}

export function tokens(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9@.]+/)
			.filter((w) => w.length > 1),
	);
}

/** Position words so a label like "Next" can be told apart by where it sits. */
export function positionHint(r: Rect, vw: number, vh: number): string {
	const cx = (r.x + r.w / 2) / Math.max(1, vw);
	const cy = (r.y + r.h / 2) / Math.max(1, vh);
	const row = cy < 1 / 3 ? "top" : cy < 2 / 3 ? "middle" : "bottom";
	const col = cx < 1 / 3 ? "left" : cx < 2 / 3 ? "centre" : "right";
	return `${row}-${col}`;
}

export function optionLine(el: ChoiceElement, vw: number, vh: number): string {
	const label = el.label.replace(/\s+/g, " ").trim().slice(0, 48) || "(no label)";
	return `${el.role} "${label}" ${positionHint(el.rect, vw, vh)}`;
}

/**
 * Pick the value to type from the caller's inputs: the key the intent names,
 * else the only input. Returns the missing key when nothing fits.
 */
export function textFor(
	intent: string,
	inputs: Record<string, string> = {},
): { text?: string; missing: string } {
	const keys = Object.keys(inputs).filter((k) => inputs[k] !== undefined && inputs[k] !== "");
	const named = keys.find((k) => tokens(intent).has(k.toLowerCase()));
	if (named) return { text: inputs[named], missing: named };
	if (keys.length === 1) return { text: inputs[keys[0]], missing: keys[0] };
	const guess = intent.match(/\b(?:the|into|in)\s+([a-z0-9-]+)\s*(?:field|box|input)?/i)?.[1];
	return { missing: guess ?? "text" };
}

/** Visible and enabled only; when over the cap, the elements sharing most words with the intent. */
export function prefilter(
	elements: ChoiceElement[],
	intent: string,
): { kept: ChoiceElement[]; prefiltered: boolean } {
	const usable = elements.filter((e) => e.visible !== false && e.enabled !== false);
	if (usable.length <= MAX_ELEMENTS) return { kept: usable, prefiltered: false };
	const want = tokens(intent);
	const score = (e: ChoiceElement) => {
		let n = 0;
		for (const w of tokens(`${e.role} ${e.label}`)) if (want.has(w)) n++;
		return n;
	};
	const ranked = usable
		.map((e, i) => ({ e, s: score(e), i }))
		.sort((a, b) => b.s - a.s || a.i - b.i)
		.slice(0, MAX_ELEMENTS)
		.sort((a, b) => a.i - b.i)
		.map((x) => x.e);
	return { kept: ranked, prefiltered: true };
}

function viewportOf(elements: ChoiceElement[], given?: { width: number; height: number }) {
	if (given) return given;
	let w = 1;
	let h = 1;
	for (const e of elements) {
		w = Math.max(w, e.rect.x + e.rect.w);
		h = Math.max(h, e.rect.y + e.rect.h);
	}
	return { width: w, height: h };
}

export async function chooseElement(input: ChooseInput): Promise<ChooseOutcome> {
	const t0 = performance.now();
	if (input.elements.length === 0) return { status: "NO_NODE" };
	const intent = input.intent.trim();
	const action: "click" | "type" = TYPE_INTENT.test(intent) ? "type" : "click";
	let text: string | undefined;
	if (action === "type") {
		const got = textFor(intent, input.inputs);
		if (got.text === undefined) return { status: "NEEDS_INPUT", missing: [got.missing] };
		text = got.text;
	}
	if (!input.allowRisky && RISKY.test(intent)) {
		return {
			status: "NEEDS_AGENT",
			reason: "intent names a risky action; pass allowRisky to permit it",
		};
	}
	const safe = input.allowRisky ? input.elements : input.elements.filter((e) => !isRisky(e));
	const hidden = input.elements.length - safe.length;
	const { kept, prefiltered } = prefilter(safe, intent);
	const meta = (extra: Partial<Meta> = {}): Meta => ({
		candidates: kept.length,
		prefiltered,
		hidden,
		ms: Math.round(performance.now() - t0),
		...extra,
	});
	if (kept.length === 0) {
		return {
			status: "NEEDS_AGENT",
			reason: hidden ? "only risky controls match" : "no visible, enabled controls",
			...meta(),
		};
	}
	const vp = viewportOf(kept, input.viewport);
	const options = [...kept.map((e) => optionLine(e, vp.width, vp.height)), NONE_OPTION];
	const state = [
		`Screen: ${kept.length} interactive elements, ${vp.width}x${vp.height}.`,
		`Task: ${intent}`,
		action === "type"
			? "The task types a value the caller already holds; pick the field to type into."
			: "",
	]
		.filter(Boolean)
		.join("\n");
	let answer: Awaited<ReturnType<Decider["choice"]>>;
	try {
		answer = await input.decider.choice(state, QUESTION, options);
	} catch (err) {
		return {
			status: "NEEDS_AGENT",
			reason: `decider failed: ${(err as Error).message}`,
			...meta(),
		};
	}
	const probs = answer.probabilities;
	const chosen = answer.chosen;
	const confidence = probs[chosen];
	let runnerUp = 0;
	for (let i = 0; i < probs.length; i++) if (i !== chosen) runnerUp = Math.max(runnerUp, probs[i]);
	const margin = confidence - runnerUp;
	const m = meta({ backend: answer.backend, model: answer.model });
	if (chosen === kept.length)
		return {
			status: "NEEDS_AGENT",
			reason: "model chose none of the listed elements",
			confidence,
			margin,
			...m,
		};
	const element = kept[chosen];
	const weak =
		confidence < MIN_CONFIDENCE
			? `confidence ${confidence.toFixed(2)} below ${MIN_CONFIDENCE}`
			: margin < MIN_MARGIN
				? `margin ${margin.toFixed(2)} below ${MIN_MARGIN}`
				: null;
	if (weak)
		return {
			status: "NEEDS_AGENT",
			reason: weak,
			heldIndex: element.index,
			confidence,
			margin,
			...m,
		};
	return {
		status: "CHOSEN",
		index: element.index,
		element,
		confidence,
		margin,
		action,
		text,
		...m,
	};
}
