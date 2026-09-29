/**
 * fixture.ts — the hand-built corpus that `recall-eval.test.ts` scores against.
 *
 * Every item is offline and synthetic: no network, no model, no clock beyond a
 * single `createdAt` capture. `buildFixture()` stamps all memories with the
 * *same* timestamp so the ranking factors inside `effectiveImportance()`
 * (time decay, access recency) are identical for every item and therefore
 * cancel out of the comparison. Ranking differences in the eval come from the
 * retriever, not from the calendar.
 *
 * Every item also shares the same `importance`. That is deliberate: the store
 * multiplies its relevance score by `0.7 + 0.3 * effectiveImportance`
 * (store.ts:346), and a constant factor cannot reorder anything, so the main
 * metrics measure *relevance ranking* rather than the importance prior. The
 * interaction between the two is measured separately, by `GAP_*` below.
 *
 * Ids are fixed strings rather than `generateId()` so query labels can name
 * them; `MemoryStore.write()` honours `memory.id` (store.ts:236).
 */

import type {
  CoreMemory,
  EpisodicMemory,
  Memory,
  ProceduralMemory,
  SemanticMemory,
  WorkingMemory,
} from "../../packages/memory/types.js";

/** Constant prior for the main corpus — see the note above. */
const NEUTRAL_IMPORTANCE = 0.5;

const PROJECT = "project" as const;
const SOURCE = "user_explicit" as const;

function base(id: string, importance: number, createdAt: number) {
  return {
    id,
    scope: PROJECT,
    importance,
    decayFactor: 1.0,
    // Pinned to 0 so the promoted-memory boost in recall.ts:62
    // (`accessCount >= 3 && importance >= 0.9`) can never fire mid-run.
    // See the "fixture integrity" test — a non-zero accessCount here would
    // make the eval order-dependent, because store.recall() bumps the
    // access_count *column* while the boost reads the JSON blob.
    accessCount: 0,
    lastAccessed: 0,
    createdAt,
    updatedAt: createdAt,
    version: 1,
    source: SOURCE,
  };
}

function semantic(
  id: string,
  key: string,
  value: string,
  createdAt: number,
  importance: number = NEUTRAL_IMPORTANCE
): SemanticMemory {
  return {
    ...base(id, importance, createdAt),
    type: "semantic",
    category: "fact",
    key,
    value,
    confidence: 1.0,
    evidenceCount: 1,
    tags: [],
    relatedKeys: [],
    learnedAt: createdAt,
    lastConfirmed: createdAt,
  };
}

/**
 * The corpus. Insertion order is part of the fixture: the store's FTS ranking
 * converts BM25 ties into `ORDER BY rank` + rowid order, so reordering this
 * array changes which of two equally-relevant memories lands first. Keep the
 * order stable.
 */
export function buildFixture(createdAt: number): Memory[] {
  const core: CoreMemory = {
    ...base("mem_fx_branch_rule", NEUTRAL_IMPORTANCE, createdAt),
    type: "core",
    category: "convention",
    key: "branch-protection",
    title: "Branch protection rules",
    content: "Never push directly to main; open a pull request on a feature branch",
    confidence: 1.0,
    evidenceCount: 2,
    tags: [],
  };

  const episodic: EpisodicMemory = {
    ...base("mem_fx_incident_retry", NEUTRAL_IMPORTANCE, createdAt),
    type: "episodic",
    content: "The payments worker crashed because of an unbounded retry queue",
    context: "post-incident review of the Tuesday outage",
    tags: [],
    entities: [],
    occurredAt: createdAt,
  };

  const procedural: ProceduralMemory = {
    ...base("mem_fx_rotate_token", NEUTRAL_IMPORTANCE, createdAt),
    type: "procedural",
    name: "rotate-forge-token",
    description: "Rotate the forge API token using the sealed notary key",
    steps: [
      { order: 1, action: "Call the forge token rotation endpoint", toolName: "http" },
      { order: 2, action: "Restart the deploy agent" },
    ],
    preconditions: ["a valid operator session"],
    successRate: 0.9,
    executionCount: 4,
    tags: [],
  };

  const working: WorkingMemory = {
    ...base("mem_fx_session_note", NEUTRAL_IMPORTANCE, createdAt),
    type: "working",
    sessionId: "session-fixture",
    key: "active-task",
    value: "The active task is to review the hazelwood migration plan",
    priority: 2,
    ttlMs: 3_600_000,
    expiresAt: createdAt + 3_600_000,
  };

  return [
    semantic(
      "mem_fx_db_port",
      "database-port",
      "The primary database listens on TCP port 5432 and runs PostgreSQL 16",
      createdAt
    ),
    core,
    semantic("mem_fx_cache_ttl", "cache-ttl", "The Redis cache default TTL is 300 seconds", createdAt),
    semantic(
      "mem_fx_deploy_target",
      "deploy-target",
      "The production deploy target is the forge runner named atlas",
      createdAt
    ),
    episodic,
    procedural,
    semantic(
      "mem_fx_reporting_schedule",
      "reporting-schedule",
      "The nightly reporting job runs at 02:00 UTC",
      createdAt
    ),
    semantic("mem_fx_billing_owner", "billing-owner", "The billing service is owned by the payments team", createdAt),
    semantic(
      "mem_fx_secret_rule",
      "secret-logging",
      "Never log secret values; redact tokens before writing logs",
      createdAt
    ),
    semantic("mem_fx_office_coffee", "office-coffee", "The office coffee machine lives on the third floor", createdAt),
    semantic("mem_fx_retention_audit", "retention-audit", "The audit log retention window is 90 days", createdAt),
    semantic("mem_fx_retention_trace", "retention-trace", "The trace retention window is 14 days", createdAt),
    working,
  ];
}

/**
 * One token that appears in exactly one corpus item — used by the
 * count-vs-retrieval agreement test. The test re-derives these from the
 * indexed text and fails if a token turns out not to be unique, so this map
 * cannot rot silently.
 */
export const PROBE_TOKENS: Record<string, string> = {
  mem_fx_db_port: "postgresql",
  mem_fx_branch_rule: "protection",
  mem_fx_cache_ttl: "redis",
  mem_fx_deploy_target: "atlas",
  mem_fx_incident_retry: "unbounded",
  mem_fx_rotate_token: "notary",
  mem_fx_reporting_schedule: "nightly",
  mem_fx_billing_owner: "billing",
  mem_fx_secret_rule: "redact",
  mem_fx_office_coffee: "coffee",
  mem_fx_retention_audit: "audit",
  mem_fx_retention_trace: "trace",
  mem_fx_session_note: "hazelwood",
};

// ── Query labels ──────────────────────────────────────────────────────

export type QueryKind = "lexical" | "ambiguous-rerank" | "paraphrase";

export interface QueryLabel {
  id: string;
  /** What the user types. */
  query: string;
  /** The memory that is the right answer. */
  primary: string;
  /** Rank (1-based) the primary is expected to hold with default options; 0 = not retrieved. */
  expectedRank: number;
  /** Rank expected when `sessionContext` is supplied (only for kind "ambiguous-rerank"). */
  expectedRankWithContext?: number;
  kind: QueryKind;
  sessionContext?: string[];
}

export const QUERY_LABELS: QueryLabel[] = [
  { id: "Q1", query: "what port does the postgres database listen on", primary: "mem_fx_db_port", expectedRank: 1, kind: "lexical" },
  { id: "Q2", query: "how do I open a pull request", primary: "mem_fx_branch_rule", expectedRank: 1, kind: "lexical" },
  { id: "Q3", query: "what is the redis cache default ttl", primary: "mem_fx_cache_ttl", expectedRank: 1, kind: "lexical" },
  { id: "Q4", query: "where does the production deploy go", primary: "mem_fx_deploy_target", expectedRank: 1, kind: "lexical" },
  { id: "Q5", query: "why did the payments worker crash", primary: "mem_fx_incident_retry", expectedRank: 1, kind: "lexical" },
  { id: "Q6", query: "how do I rotate the forge api token", primary: "mem_fx_rotate_token", expectedRank: 1, kind: "lexical" },
  { id: "Q7", query: "when does the nightly reporting job run", primary: "mem_fx_reporting_schedule", expectedRank: 1, kind: "lexical" },
  { id: "Q8", query: "who owns the billing service", primary: "mem_fx_billing_owner", expectedRank: 1, kind: "lexical" },
  { id: "Q9", query: "should I redact tokens in logs", primary: "mem_fx_secret_rule", expectedRank: 1, kind: "lexical" },
  { id: "Q10", query: "where is the coffee machine", primary: "mem_fx_office_coffee", expectedRank: 1, kind: "lexical" },
  { id: "Q11", query: "how long is the audit log retention window", primary: "mem_fx_retention_audit", expectedRank: 1, kind: "lexical" },
  { id: "Q12", query: "what should I review in the hazelwood migration plan", primary: "mem_fx_session_note", expectedRank: 1, kind: "lexical" },
  // Two memories match this query; BM25 prefers the shorter one. The baseline
  // rank below is what relevance ranking alone produces, and
  // `expectedRankWithContext` is what the session-context re-ranker (recall.ts:70)
  // has to do about it: the session is about the audit log, so audit wins.
  {
    id: "Q13",
    query: "how long is the retention window",
    primary: "mem_fx_retention_trace",
    expectedRank: 1,
    expectedRankWithContext: 2,
    kind: "ambiguous-rerank",
    sessionContext: ["audit", "log"],
  },
  {
    id: "Q14",
    query: "which tool keeps the site feeling snappy",
    primary: "mem_fx_cache_ttl",
    expectedRank: 0,
    kind: "paraphrase",
  },
];

/** The limit the harness retrieves with; also the cutoff for MRR. */
export const K = 5;

// ── Gap dataset: score composition ────────────────────────────────────

/**
 * Two memories, one query. The query's words appear substantially in exactly
 * one of them; the other merely contains the stopword "the".
 *
 * Today the exact match loses, because `_ftsSearch` throws BM25's magnitude
 * away and keeps only its position — `score = 1 / (60 + index + 1)`
 * (store.ts:726) — and `recall` then multiplies that by
 * `0.7 + 0.3 * effectiveImportance` (store.ts:346). Over ten positions the
 * rank term moves by ~13%, while the importance term moves across 30%, so a
 * high-importance memory that matches nothing outranks an exact lexical match.
 *
 * `recall-eval.test.ts` marks the expectation on this dataset as a known
 * failure rather than pretending recall is fine or pinning the inversion as
 * correct. When the composition is fixed, that test starts passing and Bun
 * turns it red as "unexpected pass" — which is the prompt to promote it.
 */
export function buildGapFixture(createdAt: number): Memory[] {
  return [
    semantic(
      "mem_gap_exact_match",
      "oncall-rota",
      "The oncall rota for the ledger squad is published every Monday",
      createdAt,
      0.2
    ),
    semantic(
      "mem_gap_high_importance_noise",
      "handbook",
      "The team handbook mentions the word rotation in passing",
      createdAt,
      0.95
    ),
  ];
}

export const GAP_QUERY: QueryLabel = {
  id: "G1",
  query: "oncall rota ledger squad",
  primary: "mem_gap_exact_match",
  expectedRank: 1,
  kind: "lexical",
};
