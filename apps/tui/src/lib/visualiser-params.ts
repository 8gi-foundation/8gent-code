/**
 * 8gent Code - Thinking Visualiser Param Vector
 *
 * TouchDesigner-style 8-dimension param vector that drives every operator.
 * Two modulation sources:
 *
 *   1. Token-stream perturbation - each emitted token (when the agent is
 *      actively producing) hashes into a small, deterministic nudge. Same
 *      token always produces the same nudge so behaviour is reproducible.
 *
 *   2. Boredom genesis - after `boredomThresholdMs` of zero activity we
 *      drift up to +/- 0.2 per dimension and pick a fresh operator. The
 *      mutation is logged to `~/.8gent/visualiser-boredom.jsonl` so we can
 *      mine the patterns later.
 *
 * Token-to-param mapping (auditable - keep this comment in sync with logic
 * below):
 *
 *   - Vowel-heavy tokens                -> nudge `hue` warmer  (toward 0.0)
 *   - Numeric tokens (digits dominate)  -> raise `density`
 *   - Whitespace-only tokens            -> damp `speed`
 *   - Long tokens (>= 8 chars)          -> raise `size`
 *   - High-entropy tokens (many uniques)-> raise `noise`
 *   - Symbol-heavy tokens               -> raise `rotation`
 *   - All others                        -> tiny hash-based wiggle on hue
 *
 * Each nudge is ~1% of range and clamped to [0, 1].
 */

import { homedir } from "node:os";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface ParamVector {
	/** Hue position 0..1, mapped only to amber-safe range (no 270-350 deg). */
	hue: number;
	/** Saturation 0..1 - colour intensity. */
	saturation: number;
	/** Density 0..1 - glyph density / particle count. */
	density: number;
	/** Speed 0..1 - frame rate multiplier. */
	speed: number;
	/** Size 0..1 - scale where applicable. */
	size: number;
	/** Distribution 0..1 - clustering vs even spread. */
	distribution: number;
	/** Noise 0..1 - jitter / randomness. */
	noise: number;
	/** Rotation 0..1 - rotation rate where applicable. */
	rotation: number;
}

export const DEFAULT_PARAMS: ParamVector = {
	hue: 0.5,
	saturation: 0.5,
	density: 0.5,
	speed: 0.5,
	size: 0.5,
	distribution: 0.5,
	noise: 0.5,
	rotation: 0.5,
};

/** Stable 32-bit FNV-1a hash. Lets the same token always produce the same nudge. */
export function hashToken(token: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < token.length; i++) {
		h ^= token.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

const VOWELS = new Set(["a", "e", "i", "o", "u", "A", "E", "I", "O", "U"]);

function clamp01(v: number): number {
	return Math.max(0, Math.min(1, v));
}

/**
 * Apply a token's deterministic nudge to the param vector. Returns a new
 * vector - never mutates the input. The nudge size is intentionally small
 * (~1% per dimension) so a long stream produces a slow drift, not chaos.
 */
export function perturbFromToken(params: ParamVector, token: string): ParamVector {
	if (!token) return params;
	const next: ParamVector = { ...params };
	const hash = hashToken(token);

	// Vowel ratio
	let vowels = 0;
	let digits = 0;
	let symbols = 0;
	const unique = new Set<string>();
	for (const ch of token) {
		if (VOWELS.has(ch)) vowels++;
		if (ch >= "0" && ch <= "9") digits++;
		if (!/[A-Za-z0-9\s]/.test(ch)) symbols++;
		unique.add(ch);
	}
	const len = token.length;
	const vowelRatio = len ? vowels / len : 0;
	const digitRatio = len ? digits / len : 0;
	const symbolRatio = len ? symbols / len : 0;
	const entropy = len ? unique.size / len : 0;
	const isWhitespace = token.trim().length === 0;

	// Vowel-heavy -> warmer (lower hue)
	if (vowelRatio > 0.4) next.hue = clamp01(next.hue - 0.012 * vowelRatio);

	// Numeric -> denser
	if (digitRatio > 0.3) next.density = clamp01(next.density + 0.015 * digitRatio);

	// Whitespace -> damp speed
	if (isWhitespace) next.speed = clamp01(next.speed - 0.02);

	// Long token -> bigger
	if (len >= 8) next.size = clamp01(next.size + 0.01);

	// High entropy -> noisier
	if (entropy > 0.6) next.noise = clamp01(next.noise + 0.012);

	// Symbol-heavy -> more rotation
	if (symbolRatio > 0.25) next.rotation = clamp01(next.rotation + 0.015);

	// Tiny default wiggle on hue based on hash bits (so plain tokens still
	// move the needle without being chaotic).
	const hueWiggle = ((hash & 0xff) / 255 - 0.5) * 0.006;
	next.hue = clamp01(next.hue + hueWiggle);

	// Saturation drifts toward 0.5 with hash bits as a stabiliser.
	const satWiggle = (((hash >> 8) & 0xff) / 255 - 0.5) * 0.004;
	next.saturation = clamp01(next.saturation + satWiggle);

	// Distribution shifts on hash high bits.
	const distWiggle = (((hash >> 16) & 0xff) / 255 - 0.5) * 0.005;
	next.distribution = clamp01(next.distribution + distWiggle);

	return next;
}

/**
 * Tiny seeded PRNG for boredom mutation. Mulberry32 - 1 line, decent
 * distribution, deterministic per seed.
 */
function mulberry32(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Boredom mutation - drift each param by up to +/- 0.2 (clamped) and
 * return a fresh vector. Determinstic per seed so unit tests can pin it.
 */
export function mutateForBoredom(params: ParamVector, seed: number): ParamVector {
	const rand = mulberry32(seed);
	return {
		hue: clamp01(params.hue + (rand() - 0.5) * 0.4),
		saturation: clamp01(params.saturation + (rand() - 0.5) * 0.4),
		density: clamp01(params.density + (rand() - 0.5) * 0.4),
		speed: clamp01(params.speed + (rand() - 0.5) * 0.4),
		size: clamp01(params.size + (rand() - 0.5) * 0.4),
		distribution: clamp01(params.distribution + (rand() - 0.5) * 0.4),
		noise: clamp01(params.noise + (rand() - 0.5) * 0.4),
		rotation: clamp01(params.rotation + (rand() - 0.5) * 0.4),
	};
}

const BOREDOM_LOG_PATH = join(homedir(), ".8gent", "visualiser-boredom.jsonl");

/**
 * Append a boredom mutation event to the JSONL log. Best-effort - swallows
 * filesystem errors so the TUI never crashes from a missing dir or a
 * read-only volume.
 */
export function logBoredomEvent(event: {
	timestamp: number;
	seed: number;
	previous: ParamVector;
	next: ParamVector;
	previousOperator: string;
	nextOperator: string;
}): void {
	try {
		mkdirSync(dirname(BOREDOM_LOG_PATH), { recursive: true });
		appendFileSync(BOREDOM_LOG_PATH, `${JSON.stringify(event)}\n`, "utf8");
	} catch {
		// Silently ignore. Visualiser must never crash the TUI.
	}
}
