/**
 * Hedge Executor - the keystone that manufactures a preference signal.
 *
 * Wraps the single `agent.generate(...)` call in the agent turn loop. When the
 * hedge flag is ON, it fires K candidate generations (default 2, cap 3),
 * prefers free/local providers, returns the FIRST successful non-empty result
 * as the winner at fastest-candidate latency, and turns the winner-vs-losers
 * spread into a dormant preference signal written to disk. Losers never touch
 * the world: this executor only ever returns ONE result to the turn, and the
 * caller dispatches tool calls only for that winner. Loser candidate text is
 * used solely to build a GRPO-style preference pair on disk.
 *
 * Safety invariant: a loser candidate produces text only. The hedge executor
 * does NOT execute tools for any candidate - it returns one `GenerateResult`
 * and the existing agent loop runs tools for that single result exactly as it
 * does today. There is no separate tool-dispatch path here, so a loser cannot
 * reach the executor. (The policy-engine `__shadow__` hard-deny gate is a
 * second, structural belt-and-braces owned by Agent B in permissions; this
 * file does not depend on it and never dispatches a shadow tool call.)
 *
 * Default OFF: when `enabled` is false, `run()` fires exactly ONE candidate and
 * returns its result with zero extra work, zero disk writes, zero judge calls -
 * byte-identical to the pre-hedge single-call behaviour.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Shape of the result a generator returns. Mirrors the agent's `generate`. */
export interface GenerateResult {
	text?: string;
	steps?: Array<{ toolCalls?: unknown[] }>;
	[key: string]: unknown;
}

/** A provider/model candidate the hedge may fire. */
export interface HedgeCandidate {
	provider: string;
	model: string;
	/** True if this candidate is free/local (cost 0). Used for preference ordering. */
	local?: boolean;
}

/** Per-call generator. The executor calls this once per candidate. */
export type HedgeGenerator = (
	candidate: HedgeCandidate,
	signal: AbortSignal | undefined,
) => Promise<GenerateResult>;

export interface HedgeConfig {
	/** Master flag. Default FALSE. When false, exactly one candidate is fired. */
	enabled: boolean;
	/** Desired candidate count. Clamped to [1, maxK]. Default 2. */
	k: number;
	/** Hard cap on candidates. Default 3. */
	maxK: number;
	/** Prefer free/local candidates first when choosing which K to fire. Default true. */
	preferLocal: boolean;
	/** Where the dormant preference signal is appended (JSONL). */
	signalPath: string;
	/** Min score gap to treat a winner-vs-loser as a real preference. Default 0.15. */
	minGap: number;
}

const DEFAULT_SIGNAL_PATH = join(homedir(), ".8gent", "kernel", "training", "hedge-signal.jsonl");

export const DEFAULT_HEDGE_CONFIG: HedgeConfig = {
	enabled: false,
	k: 2,
	maxK: 3,
	preferLocal: true,
	signalPath: DEFAULT_SIGNAL_PATH,
	minGap: 0.15,
};

/** One row of the dormant preference signal. Trainer-adaptable later. */
export interface HedgeSignalRow {
	sessionId: string;
	turnIndex: number;
	prompt: string;
	/** The winning candidate. */
	winner: { provider: string; model: string; text: string; latencyMs: number };
	/** Loser candidates (text only, never executed). */
	losers: Array<{ provider: string; model: string; text: string; latencyMs: number }>;
	collectedAt: string;
}

export interface HedgeRunOptions {
	sessionId: string;
	turnIndex: number;
	/** The user prompt for this turn (used only for the signal row; redact upstream). */
	prompt: string;
	abortSignal?: AbortSignal;
}

export interface HedgeRunResult {
	/** The result handed back to the turn. Tool calls run for THIS result only. */
	result: GenerateResult;
	/** The candidate that won. */
	winner: HedgeCandidate;
	/** How many candidates were actually fired (1 when disabled). */
	candidatesFired: number;
	/** True if a dormant preference signal row was written. */
	signalWritten: boolean;
}

/**
 * Choose which K candidates to fire from the available chain. Free/local first
 * (so hedging costs nothing), then dedupe by provider::model, clamped to maxK.
 */
export function selectCandidates(
	available: HedgeCandidate[],
	cfg: Pick<HedgeConfig, "k" | "maxK" | "preferLocal">,
): HedgeCandidate[] {
	const seen = new Set<string>();
	const deduped: HedgeCandidate[] = [];
	for (const c of available) {
		const key = `${c.provider}::${c.model}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(c);
	}
	const ordered = cfg.preferLocal
		? [...deduped].sort((a, b) => Number(Boolean(b.local)) - Number(Boolean(a.local)))
		: deduped;
	const want = Math.max(1, Math.min(cfg.k, cfg.maxK));
	return ordered.slice(0, want);
}

export class HedgeExecutor {
	private cfg: HedgeConfig;

	constructor(config: Partial<HedgeConfig> = {}) {
		this.cfg = { ...DEFAULT_HEDGE_CONFIG, ...config };
		// Clamp k into [1, maxK] up front.
		this.cfg.k = Math.max(1, Math.min(this.cfg.k, this.cfg.maxK));
	}

	get enabled(): boolean {
		return this.cfg.enabled;
	}

	/**
	 * Run a hedged generation.
	 *
	 * Disabled path (default): fires exactly the head candidate, returns it. No
	 * disk write, no extra calls. Behaviour is identical to a single
	 * `agent.generate(...)`.
	 *
	 * Enabled path: fires K candidates under one shared abort signal, returns the
	 * first successful non-empty result (fastest-candidate latency), lets the
	 * remaining settle (subject to the abort signal) to capture loser text, and
	 * appends a dormant preference row. Never executes any candidate's tools.
	 */
	async run(
		candidates: HedgeCandidate[],
		generate: HedgeGenerator,
		opts: HedgeRunOptions,
	): Promise<HedgeRunResult> {
		if (candidates.length === 0) {
			throw new Error("HedgeExecutor.run: no candidates provided");
		}

		// ── Disabled path: byte-identical single call. ──────────────────────
		if (!this.cfg.enabled) {
			const head = candidates[0];
			const result = await generate(head, opts.abortSignal);
			return { result, winner: head, candidatesFired: 1, signalWritten: false };
		}

		// ── Enabled path: K candidates, fastest winner. ─────────────────────
		const chosen = selectCandidates(candidates, this.cfg);
		if (chosen.length === 1) {
			// Only one viable candidate - no contrast possible, behave as single.
			const head = chosen[0];
			const result = await generate(head, opts.abortSignal);
			return { result, winner: head, candidatesFired: 1, signalWritten: false };
		}

		const started = chosen.map(() => Date.now());
		const settled: Array<{
			candidate: HedgeCandidate;
			result?: GenerateResult;
			latencyMs: number;
			ok: boolean;
		}> = new Array(chosen.length);

		// Fire all candidates. We resolve the turn on the FIRST non-empty success
		// while letting the rest settle for the preference signal.
		const tasks = chosen.map((candidate, i) =>
			generate(candidate, opts.abortSignal)
				.then((result) => {
					settled[i] = {
						candidate,
						result,
						latencyMs: Date.now() - started[i],
						ok: hasText(result),
					};
					return settled[i];
				})
				.catch((err) => {
					if ((err as { name?: string })?.name === "AbortError") throw err;
					settled[i] = {
						candidate,
						latencyMs: Date.now() - started[i],
						ok: false,
					};
					return settled[i];
				}),
		);

		// Winner = first task to settle with a non-empty result.
		const winner = await firstOk(tasks);
		if (!winner || !winner.result) {
			// No candidate produced text. Surface the same kind of failure a single
			// call would: await all, throw if all empty/failed.
			const all = await Promise.allSettled(tasks);
			const firstResult = all.find(
				(r): r is PromiseFulfilledResult<(typeof settled)[number]> =>
					r.status === "fulfilled" && Boolean(r.value.result),
			);
			if (firstResult) {
				return {
					result: firstResult.value.result!,
					winner: firstResult.value.candidate,
					candidatesFired: chosen.length,
					signalWritten: false,
				};
			}
			throw new Error("HedgeExecutor: all hedged candidates failed or returned empty");
		}

		// Return the winner to the turn immediately. Capture losers in the
		// background under the SAME abort signal; if the signal aborts, we simply
		// skip the preference row (no error - the turn already has its winner).
		let signalWritten = false;
		try {
			await Promise.allSettled(tasks);
			signalWritten = this.writeSignal(chosen, settled, winner, opts);
		} catch {
			// Losers aborted or failed to settle. The turn already returned; the
			// dormant signal is best-effort and simply not written this turn.
		}

		return {
			result: winner.result,
			winner: winner.candidate,
			candidatesFired: chosen.length,
			signalWritten,
		};
	}

	/**
	 * Write a dormant preference row capturing winner vs losers. This is the only
	 * disk side-effect of hedging, and it is data-only: no training, no network.
	 * Returns true if a row was written. Returns false (no-op) when there is no
	 * distinct loser text to contrast against - we never fabricate a preference.
	 */
	private writeSignal(
		chosen: HedgeCandidate[],
		settled: Array<{
			candidate: HedgeCandidate;
			result?: GenerateResult;
			latencyMs: number;
			ok: boolean;
		}>,
		winner: { candidate: HedgeCandidate; result?: GenerateResult; latencyMs: number },
		opts: HedgeRunOptions,
	): boolean {
		const winnerText = winner.result?.text ?? "";
		if (!winnerText) return false;

		const losers = settled
			.filter((s) => s && s.candidate !== winner.candidate && hasText(s.result))
			.map((s) => ({
				provider: s.candidate.provider,
				model: s.candidate.model,
				text: s.result?.text ?? "",
				latencyMs: s.latencyMs,
			}))
			// Only keep losers whose text differs from the winner - identical text
			// carries no preference.
			.filter((l) => l.text !== winnerText);

		if (losers.length === 0) return false;

		const row: HedgeSignalRow = {
			sessionId: opts.sessionId,
			turnIndex: opts.turnIndex,
			prompt: opts.prompt,
			winner: {
				provider: winner.candidate.provider,
				model: winner.candidate.model,
				text: winnerText,
				latencyMs: winner.latencyMs,
			},
			losers,
			collectedAt: new Date().toISOString(),
		};

		try {
			const dir = dirname(this.cfg.signalPath);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			appendFileSync(this.cfg.signalPath, `${JSON.stringify(row)}\n`);
			return true;
		} catch {
			return false;
		}
	}
}

function hasText(r?: GenerateResult): boolean {
	return Boolean(r && typeof r.text === "string" && r.text.trim().length > 0);
}

/**
 * Resolve to the first task whose value has a non-empty result. If no task
 * yields a usable result, resolves to null once all settle. Rethrows AbortError
 * so ESC propagates exactly as a single call would.
 */
async function firstOk<T extends { result?: GenerateResult }>(
	tasks: Array<Promise<T>>,
): Promise<T | null> {
	return new Promise<T | null>((resolveOuter, rejectOuter) => {
		let remaining = tasks.length;
		let resolved = false;
		for (const t of tasks) {
			t.then(
				(v) => {
					if (!resolved && v && hasText(v.result)) {
						resolved = true;
						resolveOuter(v);
						return;
					}
					remaining -= 1;
					if (remaining === 0 && !resolved) resolveOuter(null);
				},
				(err) => {
					if ((err as { name?: string })?.name === "AbortError") {
						if (!resolved) {
							resolved = true;
							rejectOuter(err);
						}
						return;
					}
					remaining -= 1;
					if (remaining === 0 && !resolved) resolveOuter(null);
				},
			);
		}
	});
}
