/**
 * recall-eval.test.ts — the smallest honest evaluation harness for memory retrieval.
 *
 * Why this file exists: `recall` was only ever eyeballed. That is how a bug
 * shipped where `memory stats` answered "0" while `recall` returned entries over
 * the same store — nothing asked whether the two answers agreed, and nothing
 * asked whether recall was any good. This harness asks both, offline, and fails
 * loudly when either regresses.
 *
 * What it scores (measured against the code as it is, nothing invented):
 *   - input           `SemanticRecall.recall(query, { limit })` — recall.ts:47
 *   - retrieved ids   `SearchResult["memory"]["id"]`
 *   - relevance       FTS5 BM25 (`_ftsSearch`, store.ts:675) surfaced through the
 *                     rank-position score at store.ts:726, then importance-weighted
 *                     (store.ts:346)
 *   - re-ranker       the session-context word-overlap boost, recall.ts:70
 *   - metrics         Recall@1, Recall@3, MRR@5 over `./fixture.ts`
 *
 * Hermetic by construction:
 *   - the embedding provider is stubbed unavailable per test run, so the
 *     Ollama/vector leg can never join (`pinOfflineEmbeddings`), which makes the
 *     run identical on a laptop with no model server and on one running
 *     `nomic-embed-text`;
 *   - one shared `createdAt` and one shared importance for the whole corpus, so
 *     `effectiveImportance()` and the importance multiplier cancel out;
 *   - every fixture item has `accessCount: 0`, so the promoted boost cannot fire
 *     (asserted in "fixture integrity");
 *   - the stores are `:memory:` — private to the run and impossible to leak;
 *     no sleeps, no network, no model calls.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

import * as realEmbeddings from "../../packages/memory/embeddings.js";
import type { SemanticRecall } from "../../packages/memory/recall.js";
import type { MemoryStore } from "../../packages/memory/store.js";
import type { Memory, SearchResult } from "../../packages/memory/types.js";
import {
  GAP_QUERY,
  K,
  PROBE_TOKENS,
  QUERY_LABELS,
  buildFixture,
  buildGapFixture,
  type QueryLabel,
} from "./fixture.js";

// ── The harness ───────────────────────────────────────────────────────

/** The seam a future reranker plugs into: query in, ranked ids out. */
export type Retriever = (
  query: string,
  options: { limit: number; sessionContext?: string[] }
) => Promise<Array<{ id: string; score: number }>>;

export interface EvalRow {
  label: QueryLabel;
  ranked: string[];
}

export interface Metrics {
  queries: number;
  recallAt1: number;
  recallAt3: number;
  mrr: number;
}

/** 1-based rank of `id` in `ranked`, or 0 when absent (cutoff K). */
export function rankOf(ranked: string[], id: string): number {
  const index = ranked.slice(0, K).indexOf(id);
  return index === -1 ? 0 : index + 1;
}

export function computeMetrics(rows: EvalRow[]): Metrics {
  if (rows.length === 0) return { queries: 0, recallAt1: 0, recallAt3: 0, mrr: 0 };
  let hit1 = 0;
  let hit3 = 0;
  let reciprocal = 0;
  for (const row of rows) {
    const rank = rankOf(row.ranked, row.label.primary);
    if (rank === 1) hit1++;
    if (rank > 0 && rank <= 3) hit3++;
    reciprocal += rank === 0 ? 0 : 1 / rank;
  }
  return {
    queries: rows.length,
    recallAt1: hit1 / rows.length,
    recallAt3: hit3 / rows.length,
    mrr: reciprocal / rows.length,
  };
}

/**
 * Run a retriever over labelled queries. `useSessionContext` decides whether a
 * label's `sessionContext` is handed to the retriever, so the baseline metrics
 * are not silently measured with the re-ranker switched on.
 */
export async function runEval(
  retrieve: Retriever,
  labels: QueryLabel[],
  options: { useSessionContext?: boolean } = {}
): Promise<EvalRow[]> {
  const rows: EvalRow[] = [];
  for (const label of labels) {
    const hits = await retrieve(label.query, {
      limit: K,
      sessionContext: options.useSessionContext ? label.sessionContext : undefined,
    });
    rows.push({ label, ranked: hits.map((hit) => hit.id) });
  }
  return rows;
}

export function formatMetrics(name: string, m: Metrics): string {
  return `[recall-eval] ${name}: n=${m.queries} Recall@1=${m.recallAt1.toFixed(3)} Recall@3=${m.recallAt3.toFixed(3)} MRR@${K}=${m.mrr.toFixed(3)}`;
}

export function formatRanks(rows: EvalRow[]): string {
  return `[recall-eval] per-query rank:\n${rows
    .map((row) => `  ${row.label.id} rank=${rankOf(row.ranked, row.label.primary)} ${row.label.kind} :: ${row.label.query}`)
    .join("\n")}`;
}

// ── Floors ────────────────────────────────────────────────────────────
// Ratchets, not decorations. Each floor is exactly what today's retrieval path
// scores (see the printed table), so a single query moving down a rank turns one
// of them red instead of quietly shipping. Raise them when the path improves.
const LEXICAL_FLOORS: Metrics = { queries: 12, recallAt1: 1.0, recallAt3: 1.0, mrr: 1.0 };
const OVERALL_FLOORS: Metrics = { queries: 14, recallAt1: 0.92, recallAt3: 0.92, mrr: 0.92 };

// ── Offline pin ───────────────────────────────────────────────────────

let embeddingProviderCalls = 0;

/**
 * Freeze the retriever on the FTS-only path.
 *
 * `SemanticRecall`'s constructor calls `_warmEmbeddings()` (recall.ts:39), which
 * asks Ollama whether `nomic-embed-text` is loaded and, if it is, switches the
 * store to hybrid RRF scoring. That would make the eval's numbers depend on
 * what happens to be running on localhost:11434. Measuring the vector leg is a
 * separate job; this harness measures the leg that is always present.
 *
 * Must run before the modules under test are imported, which is why those
 * imports below are dynamic: a static import would bind the real
 * `getEmbeddingProvider` at file-evaluation time and the mock would be too late.
 */
function pinOfflineEmbeddings(): void {
  const unavailable = {
    dimensions: 0,
    model: "none",
    available: false,
    generate: async () => new Float32Array(0),
    generateBatch: async () => [new Float32Array(0)],
  };
  mock.module("../../packages/memory/embeddings.js", () => ({
    ...realEmbeddings,
    getEmbeddingProvider: async () => {
      embeddingProviderCalls++;
      return unavailable;
    },
  }));
}

// ── Suite ─────────────────────────────────────────────────────────────

let store: MemoryStore;
let recall: SemanticRecall;
let corpus: Memory[];

let gapStore: MemoryStore;
let gapRecall: SemanticRecall;

function asRetriever(recaller: SemanticRecall): Retriever {
  return async (query, options) => {
    const results = (await recaller.recall(query, {
      limit: options.limit,
      sessionContext: options.sessionContext,
    })) as SearchResult[];
    return results.map((result) => ({ id: result.memory.id, score: result.score }));
  };
}

beforeAll(async () => {
  pinOfflineEmbeddings();
  const { MemoryStore: Store } = await import("../../packages/memory/store.js");
  const { createSemanticRecall } = await import("../../packages/memory/recall.js");

  // In-memory stores: no temp files to leak on a full disk, nothing to clean up,
  // and the ranking under test is identical (BM25 over the same FTS5 index).
  store = new Store(":memory:");
  corpus = buildFixture(Date.now());
  store.writeBatch(corpus);
  // `SemanticRecall` is what the agent loop calls; it is the thing being scored.
  recall = createSemanticRecall(store);

  gapStore = new Store(":memory:");
  gapStore.writeBatch(buildGapFixture(Date.now()));
  gapRecall = createSemanticRecall(gapStore);
});

afterAll(() => {
  mock.restore();
  for (const handle of [store, gapStore]) {
    try {
      handle?.close();
    } catch {
      // already closed
    }
  }
});

describe("memory recall eval", () => {
  test("the harness is offline: the embedding provider is stubbed, not probed", () => {
    expect(embeddingProviderCalls).toBeGreaterThan(0);
    expect(recall.isEmbeddingReady()).toBe(false);
    expect(store.getStats().embeddingsCount).toBe(0);
  });

  test("fixture integrity: probe tokens are unique and no item can be boosted mid-run", () => {
    const rows = store.getDb().prepare("SELECT id, data, content_text FROM memories").all() as Array<{
      id: string;
      data: string;
      content_text: string;
    }>;

    expect(rows.length).toBe(corpus.length);

    // The count question and the retrieval question below are only comparable
    // if each probe token names exactly one memory in the *indexed* text.
    for (const [id, token] of Object.entries(PROBE_TOKENS)) {
      const owners = rows.filter((row) => row.content_text.toLowerCase().includes(token));
      expect({ token, owners: owners.map((row) => row.id) }).toEqual({ token, owners: [id] });
    }

    // Ranking must not drift between the passes this suite makes: a baked
    // accessCount >= 3 would let recall.ts:62's promoted boost fire mid-run and
    // make the numbers depend on how many times a query had already run.
    const boosted = rows.filter((row) => (JSON.parse(row.data) as Memory).accessCount >= 3);
    expect(boosted.map((row) => row.id)).toEqual([]);
  });

  // The case that would have caught the shipped `memory stats` == 0 bug: two
  // questions asked of one store may not disagree about whether it has data.
  test("count and retrieval agree over the same store", async () => {
    const stats = store.getStats();
    const retrieve = asRetriever(recall);

    // Each probe names one memory; "reachable" is the set of memories that
    // actually answered their own probe through the public recall path.
    const reachable = new Set<string>();
    for (const [id, token] of Object.entries(PROBE_TOKENS)) {
      const ranked = (await retrieve(token, { limit: K })).map((hit) => hit.id);
      if (ranked.includes(id)) reachable.add(id);
    }

    // One question counted a store, the other read it. If they disagree, one of
    // them is answering about something else — the exact failure mode of the
    // reported bug, where a count of 0 sat next to recall results.
    const agreement = {
      statsTotal: stats.total,
      reachable: reachable.size,
    };
    expect(agreement).toEqual({ statsTotal: corpus.length, reachable: corpus.length });
    expect([...reachable].sort()).toEqual(corpus.map((memory) => memory.id).sort());
  });

  test("every labelled query retrieves its primary where it should be", async () => {
    const rows = await runEval(asRetriever(recall), QUERY_LABELS);
    const mismatches = rows
      .map((row) => ({
        id: row.label.id,
        query: row.label.query,
        expected: row.label.expectedRank,
        actual: rankOf(row.ranked, row.label.primary),
        ranked: row.ranked,
      }))
      .filter((row) => row.actual !== row.expected);
    expect(mismatches).toEqual([]);
  });

  test("metrics stay above the floors", async () => {
    const rows = await runEval(asRetriever(recall), QUERY_LABELS);
    const overall = computeMetrics(rows);
    const lexical = computeMetrics(rows.filter((row) => row.label.kind === "lexical"));
    const other = computeMetrics(rows.filter((row) => row.label.kind !== "lexical"));

    // Printed so `bun test` shows the numbers, not just a green tick.
    console.log(formatMetrics("all queries", overall));
    console.log(formatMetrics("lexical", lexical));
    console.log(formatMetrics("ambiguous+paraphrase", other));
    console.log(formatRanks(rows));

    expect(overall.recallAt1).toBeGreaterThanOrEqual(OVERALL_FLOORS.recallAt1);
    expect(overall.recallAt3).toBeGreaterThanOrEqual(OVERALL_FLOORS.recallAt3);
    expect(overall.mrr).toBeGreaterThanOrEqual(OVERALL_FLOORS.mrr);
    expect(lexical.recallAt1).toBeGreaterThanOrEqual(LEXICAL_FLOORS.recallAt1);
    expect(lexical.recallAt3).toBeGreaterThanOrEqual(LEXICAL_FLOORS.recallAt3);
    expect(lexical.mrr).toBeGreaterThanOrEqual(LEXICAL_FLOORS.mrr);
  });

  test("session context re-ranks the ambiguous query instead of leaving it to BM25", async () => {
    const label = QUERY_LABELS.find((row) => row.id === "Q13");
    expect(label).toBeDefined();
    if (!label) return;

    const retrieve = asRetriever(recall);
    const baseline = (await runEval(retrieve, [label]))[0].ranked;
    const reranked = (await runEval(retrieve, [label], { useSessionContext: true }))[0].ranked;

    // Both retention memories match the query; BM25 prefers the shorter one, and
    // the overlap re-ranker is then asked to prefer the one the session is about.
    expect(baseline.slice(0, 2)).toEqual(["mem_fx_retention_trace", "mem_fx_retention_audit"]);
    expect(rankOf(baseline, label.primary)).toBe(label.expectedRank);
    const expectedWithContext = label.expectedRankWithContext;
    if (expectedWithContext === undefined) throw new Error("Q13 must declare expectedRankWithContext");
    expect(rankOf(reranked, label.primary)).toBe(expectedWithContext);

    const swap = { baselineTop: baseline[0], rerankedTop: reranked[0] };
    expect(swap).toEqual({ baselineTop: "mem_fx_retention_trace", rerankedTop: "mem_fx_retention_audit" });

    console.log(`[recall-eval] Q13 ranking without session context: ${baseline.join(" > ")}`);
    console.log(`[recall-eval] Q13 ranking with session context ['audit','log']: ${reranked.join(" > ")}`);
  });

  test("a second pass retrieves exactly the same ranking (deterministic)", async () => {
    const retrieve = asRetriever(recall);
    const first = await runEval(retrieve, QUERY_LABELS);
    const second = await runEval(retrieve, QUERY_LABELS);
    expect(second.map((row) => row.ranked)).toEqual(first.map((row) => row.ranked));
  });

  // ── Known gap ───────────────────────────────────────────────────────
  // `test.failing`, not a weakened assertion: the expectation below is the one
  // the product needs. It fails today because `_ftsSearch` keeps only BM25's
  // *position* (store.ts:726, `score = 1 / (60 + index + 1)`) and `recall` then
  // multiplies that by `0.7 + 0.3 * effectiveImportance` (store.ts:346). Across
  // ten positions the rank term spans ~13%; the importance term spans 30%. So a
  // 0.95-importance memory that matches only the stopword "the" outranks a
  // 0.2-importance memory that matches every word of the query.
  //
  // When the score composition is fixed this test starts passing, and Bun
  // reports that as an unexpected pass — which is the prompt to promote it into
  // the floors above. Nothing else in the harness depends on the gap persisting.
  test.failing("known gap: an exact lexical match can be buried by importance weighting", async () => {
    const rows = await runEval(asRetriever(gapRecall), [GAP_QUERY]);
    console.log(formatMetrics("exact-match vs high-importance noise", computeMetrics(rows)));
    expect(rankOf(rows[0].ranked, GAP_QUERY.primary)).toBe(1);
  });
});
