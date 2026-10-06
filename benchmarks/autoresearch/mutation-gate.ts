/**
 * mutation-gate.ts - keep a prompt rule only if it helps on tasks it was not
 * derived from (#3556).
 *
 * Without this, autoresearch-loop.ts adds every rule analyzeAndMutate() emits
 * straight into the system prompt and never removes one, so the prompt only
 * grows and nothing checks that a rule helps beyond the task it came from.
 *
 * What the gate guarantees: a kept batch does not lower the held-out mean, and
 * the held-out mean is a clean signal (no rule derived from a held-out task is
 * ever in the prompt, including rules restored from loop-state.json).
 *
 * What it does NOT guarantee: that answer-key rules are rejected. A rule that
 * spells out the answer for a TUNING id (e.g. SD001, or MR001 in an agentic
 * run) lifts the tuning mean and leaves held-out unchanged, so it is kept.
 * Requiring held-out to rise is a separate design change.
 *
 * With AUTORESEARCH_GATE=1 the loop:
 *   1. splits benchmark ids into tuning and held-out by a stable hash,
 *   2. derives candidate rules from TUNING failures only,
 *   3. reruns the suite with the candidates added,
 *   4. keeps the batch only if the tuning mean rises by at least minGain and
 *      the held-out mean does not drop; otherwise restores the prompt,
 *   5. appends kept batches to a proposal file for human review.
 *
 * Fails closed: an empty held-out set, or a rerun that throws, keeps nothing.
 * A single benchmark that fails inside the rerun scores 0 (scoreAll), the same
 * as in the first sweep, rather than aborting the whole rerun.
 * Off by default; with the flag unset the loop behaves exactly as before.
 *
 * Does NOT: judge rules one at a time (one rerun per batch), repeat runs to
 * average out noise, or edit any tracked prompt file. Concept from GEPA
 * (arXiv 2507.19457); no GEPA code is used.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Scores = Record<string, number>;

export interface Split {
	tuning: string[];
	heldOut: string[];
}

export interface GateDecision {
	keep: boolean;
	reason: string;
	tuningBefore: number;
	tuningAfter: number;
	heldOutBefore: number;
	heldOutAfter: number;
}

export interface GateResult extends GateDecision {
	kept: string[];
	discarded: string[];
	after: Scores;
}

export function isGateEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env.AUTORESEARCH_GATE === "1";
}

/** FNV-1a 32-bit. Stable across runs and machines. */
function hashId(id: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}

/**
 * Deterministic split: ids ordered by hash, the first ceil(n * pct / 100) are
 * held out. Two or more ids always leave both sides non-empty.
 */
export function splitIds(ids: string[], heldOutPercent = 30): Split {
	const unique = [...new Set(ids)];
	const ordered = unique.sort((a, b) => hashId(a) - hashId(b) || a.localeCompare(b));
	if (ordered.length < 2) return { tuning: ordered, heldOut: [] };
	const n = Math.min(
		ordered.length - 1,
		Math.max(1, Math.ceil((ordered.length * heldOutPercent) / 100)),
	);
	return { tuning: ordered.slice(n).sort(), heldOut: ordered.slice(0, n).sort() };
}

function mean(scores: Scores, ids: string[]): number {
	if (ids.length === 0) return 0;
	return ids.reduce((sum, id) => sum + (scores[id] ?? 0), 0) / ids.length;
}

export function decide(before: Scores, after: Scores, split: Split, minGain = 1): GateDecision {
	const d = {
		tuningBefore: mean(before, split.tuning),
		tuningAfter: mean(after, split.tuning),
		heldOutBefore: mean(before, split.heldOut),
		heldOutAfter: mean(after, split.heldOut),
	};
	if (split.heldOut.length === 0 || split.tuning.length === 0) {
		return { ...d, keep: false, reason: "split has an empty side; nothing can be validated" };
	}
	if (d.heldOutAfter < d.heldOutBefore) {
		return {
			...d,
			keep: false,
			reason: `held-out dropped ${d.heldOutBefore.toFixed(1)} -> ${d.heldOutAfter.toFixed(1)}`,
		};
	}
	if (d.tuningAfter < d.tuningBefore + minGain) {
		return {
			...d,
			keep: false,
			reason: `tuning gain ${(d.tuningAfter - d.tuningBefore).toFixed(1)} below ${minGain}`,
		};
	}
	return {
		...d,
		keep: true,
		reason: `tuning ${d.tuningBefore.toFixed(1)} -> ${d.tuningAfter.toFixed(1)}, held-out ${d.heldOutBefore.toFixed(1)} -> ${d.heldOutAfter.toFixed(1)}`,
	};
}

/** The benchmark id a rule was derived from: "[LH001] ..." -> "LH001". */
export function mutationSourceId(mutation: string): string | null {
	const m = /^\[([^\]]+)\]/.exec(mutation);
	return m ? m[1] : null;
}

/**
 * Drop restored rules whose source id is held out, so a state file written by
 * an earlier (ungated) run cannot contaminate the held-out mean.
 */
export function dropHeldOutMutations(
	mutations: string[],
	split: Split,
): { kept: string[]; dropped: string[] } {
	const held = new Set(split.heldOut);
	const kept: string[] = [];
	const dropped: string[] = [];
	for (const m of mutations) {
		const id = mutationSourceId(m);
		(id !== null && held.has(id) ? dropped : kept).push(m);
	}
	return { kept, dropped };
}

/**
 * Score every item; one that throws scores 0 instead of aborting the batch.
 * Matches the first sweep in autoresearch-loop.ts so before/after are symmetric.
 */
export async function scoreAll<T extends { id: string }>(
	items: T[],
	score: (item: T) => Promise<number>,
	onError?: (item: T, err: unknown) => void,
): Promise<Scores> {
	const out: Scores = {};
	for (const item of items) {
		try {
			out[item.id] = await score(item);
		} catch (err) {
			onError?.(item, err);
			out[item.id] = 0;
		}
	}
	return out;
}

export async function gateCandidates(opts: {
	candidates: string[];
	accepted: string[];
	before: Scores;
	split: Split;
	apply: (mutations: string[]) => void;
	rerun: () => Promise<Scores>;
	minGain?: number;
}): Promise<GateResult> {
	const { candidates, accepted, before, split, apply, rerun, minGain } = opts;
	const none = decide(before, before, split, minGain);
	if (candidates.length === 0) {
		return {
			...none,
			keep: false,
			reason: "no candidates",
			kept: [],
			discarded: [],
			after: before,
		};
	}
	apply([...accepted, ...candidates]);
	let after: Scores;
	try {
		after = await rerun();
	} catch (err) {
		apply(accepted);
		return {
			...none,
			keep: false,
			reason: `rerun failed: ${err instanceof Error ? err.message : String(err)}`,
			kept: [],
			discarded: [...candidates],
			after: {},
		};
	}
	const d = decide(before, after, split, minGain);
	if (!d.keep) apply(accepted);
	return {
		...d,
		kept: d.keep ? [...candidates] : [],
		discarded: d.keep ? [] : [...candidates],
		after,
	};
}

/** One JSON line per kept batch. A human turns these into a PR; nothing auto-merges. */
export function appendProposal(path: string, entry: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(entry)}\n`);
}
