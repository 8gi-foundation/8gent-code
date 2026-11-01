/**
 * Pair Adapter - the missing connector between collection and training.
 *
 * The PersonalCollector writes scored single-response `TrainingPair`s to
 * `.8gent/kernel/training/pairs.jsonl`. The LoRA trainer (`train_lora.py`) reads
 * preference pairs in GRPO shape (`chosen` vs `rejected` for the same prompt).
 * Nothing connected the two. This converts: group by prompt, and where one prompt
 * has two responses with a real score spread, pair the best as `chosen` and the
 * worst as `rejected`. Prompts with a single response, or no genuine preference,
 * are skipped - we never fabricate a preference the data does not support.
 *
 * This is dormant plumbing: it runs on collected data only, trains nothing, and
 * sends nothing off-device. It exists so that when multi-candidate data arrives
 * (e.g. from hedged inference), it is already trainer-ready.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TrainingPair } from "./personal-collector";

export interface GrpoPair {
	prompt: string;
	chosen: string;
	rejected: string;
	chosen_score: number;
	rejected_score: number;
	session_id: string;
	collected_at: string;
}

export interface AdaptOptions {
	/** Minimum score gap between chosen and rejected to count as a real
	 * preference. Below this, the two responses are treated as a tie and skipped. */
	minGap?: number;
}

/**
 * Convert scored `TrainingPair`s into GRPO preference pairs. Groups by prompt;
 * for each prompt with at least two responses whose scores differ by >= minGap,
 * pairs the highest-scored response as `chosen` and the lowest as `rejected`.
 */
export function toGrpoPairs(pairs: TrainingPair[], opts: AdaptOptions = {}): GrpoPair[] {
	const minGap = opts.minGap ?? 0.15;
	const byPrompt = new Map<string, TrainingPair[]>();
	for (const p of pairs) {
		const arr = byPrompt.get(p.prompt) ?? [];
		arr.push(p);
		byPrompt.set(p.prompt, arr);
	}

	const out: GrpoPair[] = [];
	for (const [prompt, group] of byPrompt) {
		if (group.length < 2) continue; // need a contrast to express a preference
		const sorted = [...group].sort((a, b) => b.score - a.score);
		const best = sorted[0];
		const worst = sorted[sorted.length - 1];
		if (best.score - worst.score < minGap) continue; // no real preference
		if (best.response === worst.response) continue; // identical text, nothing to learn
		out.push({
			prompt,
			chosen: best.response,
			rejected: worst.response,
			chosen_score: best.score,
			rejected_score: worst.score,
			session_id: best.sessionId,
			collected_at: new Date(best.collectedAt).toISOString(),
		});
	}
	return out;
}

/**
 * A hedge-signal row, as written by the hedge executor: one winner and one or
 * more losers for the same prompt. This is the multi-candidate contrast the
 * pair adapter was written for. We mirror the shape structurally (not by import)
 * to keep this module dependency-light.
 */
interface HedgeSignalRowLike {
	prompt: string;
	winner: { text: string; provider?: string; model?: string };
	losers: Array<{ text: string; provider?: string; model?: string }>;
	collectedAt?: string;
	sessionId?: string;
}

/**
 * Convert hedge-signal rows directly into GRPO pairs. Each row already carries a
 * winner and losers for one prompt, so a preference is explicit: winner is
 * `chosen`, the FIRST distinct loser is `rejected`. Rows with no distinct loser
 * are skipped. Scores are not present on a hedge row (the winner-vs-loser
 * preference IS the signal), so we mark a nominal spread of 1.0 vs 0.0 to record
 * the ordering without asserting a magnitude.
 */
export function hedgeRowsToGrpoPairs(rows: HedgeSignalRowLike[]): GrpoPair[] {
	const out: GrpoPair[] = [];
	for (const row of rows) {
		const winnerText = row.winner?.text ?? "";
		if (!winnerText) continue;
		const loser = (row.losers ?? []).find((l) => l.text && l.text !== winnerText);
		if (!loser) continue;
		out.push({
			prompt: row.prompt,
			chosen: winnerText,
			rejected: loser.text,
			chosen_score: 1,
			rejected_score: 0,
			session_id: row.sessionId ?? "",
			collected_at: row.collectedAt ?? new Date().toISOString(),
		});
	}
	return out;
}

/**
 * Read `pairs.jsonl`, convert to GRPO pairs, and write them to `outPath` as
 * JSONL the trainer consumes. Returns the number of pairs written. Malformed
 * lines are skipped. Missing input yields 0 (and writes nothing).
 *
 * If `hedgeSignalPath` is provided and exists, hedge-derived contrast pairs are
 * folded in alongside the collected single-response pairs. With neither source
 * producing a genuine contrast, zero pairs are written (no fabricated preference).
 */
export function adaptPairsFile(
	pairsPath: string,
	outPath: string,
	opts?: AdaptOptions & { hedgeSignalPath?: string },
): number {
	const pairs: TrainingPair[] = [];
	if (existsSync(pairsPath)) {
		for (const line of readFileSync(pairsPath, "utf-8").split("\n")) {
			const s = line.trim();
			if (!s) continue;
			try {
				pairs.push(JSON.parse(s) as TrainingPair);
			} catch {
				// Skip a malformed line rather than abort the whole conversion.
			}
		}
	}
	const grpo = toGrpoPairs(pairs, opts);

	// Fold in hedge-derived contrast pairs when a signal file is present.
	const hedgePath = opts?.hedgeSignalPath;
	if (hedgePath && existsSync(hedgePath)) {
		const rows: HedgeSignalRowLike[] = [];
		for (const line of readFileSync(hedgePath, "utf-8").split("\n")) {
			const s = line.trim();
			if (!s) continue;
			try {
				rows.push(JSON.parse(s) as HedgeSignalRowLike);
			} catch {
				// Skip malformed hedge rows.
			}
		}
		grpo.push(...hedgeRowsToGrpoPairs(rows));
	}

	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, grpo.map((g) => JSON.stringify(g)).join("\n") + (grpo.length ? "\n" : ""));
	return grpo.length;
}
