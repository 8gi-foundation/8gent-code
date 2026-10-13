/**
 * Prefill report (#3655): reads the model_round lines EIGHT_PREFIX_METER=1
 * writes into a session jsonl and prints one row per round plus totals, so a
 * pilot run shows at a glance whether prefill or generation takes the time.
 *
 *   bun packages/ai/prefill-report.ts ~/.8gent/sessions/session_<id>.jsonl
 *
 * Prefill seconds are the provider's prompt_eval time when it reports one,
 * otherwise the wait for reply headers (marked ~): on a streamed reply nothing
 * arrives until the prompt is read, so that wait is roughly the prefill.
 */
import * as fs from "node:fs";
import type { ModelRoundEntry } from "../specifications/session/index.js";

export type PrefillTotals = {
	rounds: number;
	prefillTokens: number;
	genTokens: number;
	prefillMs: number;
	genMs: number;
	estimated: number;
};

export function parseRounds(jsonl: string): ModelRoundEntry[] {
	const out: ModelRoundEntry[] = [];
	for (const line of jsonl.split("\n")) {
		if (!line.includes('"model_round"')) continue;
		try {
			const e = JSON.parse(line);
			if (e?.type === "model_round") out.push(e);
		} catch {}
	}
	return out;
}

/** Prefill and generation ms for one round, and whether prefill is estimated. */
export function splitRound(r: ModelRoundEntry): { prefill: number; gen: number; est: boolean } {
	if (r.promptEvalMs !== undefined && r.evalMs !== undefined) {
		return { prefill: r.promptEvalMs, gen: r.evalMs, est: false };
	}
	return { prefill: r.headersMs, gen: Math.max(0, r.wallMs - r.headersMs), est: true };
}

export function totals(rounds: ModelRoundEntry[]): PrefillTotals {
	const t = { rounds: 0, prefillTokens: 0, genTokens: 0, prefillMs: 0, genMs: 0, estimated: 0 };
	for (const r of rounds) {
		const s = splitRound(r);
		t.rounds++;
		t.prefillTokens += r.promptTokens ?? 0;
		t.genTokens += r.completionTokens ?? 0;
		t.prefillMs += s.prefill;
		t.genMs += s.gen;
		if (s.est) t.estimated++;
	}
	return t;
}

if (import.meta.main) {
	const file = process.argv[2];
	if (!file) throw new Error("usage: bun packages/ai/prefill-report.ts <session.jsonl>");
	const rounds = parseRounds(fs.readFileSync(file, "utf8"));
	const sec = (ms: number) => (ms / 1000).toFixed(1);
	console.log("round  path  hist_chars  prefill_tok  gen_tok  prefill_s  gen_s  wall_s");
	for (const r of rounds) {
		const s = splitRound(r);
		const cols = [r.round, r.path, r.promptChars, r.promptTokens ?? "-", r.completionTokens ?? "-"];
		console.log(
			[...cols, `${s.est ? "~" : ""}${sec(s.prefill)}`, sec(s.gen), sec(r.wallMs)].join("  "),
		);
	}
	const t = totals(rounds);
	const share =
		t.prefillMs + t.genMs > 0 ? Math.round((100 * t.prefillMs) / (t.prefillMs + t.genMs)) : 0;
	console.log(
		`TOTAL ${t.rounds} rounds: prefill ${t.prefillTokens} tok ${sec(t.prefillMs)} s (${share}%), ` +
			`generation ${t.genTokens} tok ${sec(t.genMs)} s; ${t.estimated} prefill times from headers (~)`,
	);
}
