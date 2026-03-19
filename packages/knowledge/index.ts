/**
 * @8gent/knowledge — BM25+ search over a persistent knowledge base
 *
 * Inspired by CashClaw's learning system. Entries are scored with BM25+
 * and temporally decayed so recent knowledge surfaces first.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KnowledgeCategory =
  | "pattern"
  | "error"
  | "preference"
  | "codebase";

export interface KnowledgeEntry {
  id: string;
  content: string;
  category: KnowledgeCategory;
  source: string;
  score?: number;
  createdAt: string; // ISO-8601
  lastAccessedAt: string; // ISO-8601
}

// ---------------------------------------------------------------------------
// BM25+ helpers
// ---------------------------------------------------------------------------

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const HALF_LIFE_DAYS = 30;
const MAX_ENTRIES = 100;
const PRUNE_AGE_DAYS = 90;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function termFrequencies(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return freq;
}

function temporalDecay(createdAt: string): number {
  const ageDays =
    (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  return Math.exp((-0.693 * ageDays) / HALF_LIFE_DAYS);
}

// ---------------------------------------------------------------------------
// KnowledgeBase
// ---------------------------------------------------------------------------

export class KnowledgeBase {
  private entries: KnowledgeEntry[] = [];
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath =
      filePath ?? `${homedir()}/.8gent/knowledge.json`;
    this.load();
  }

  // -- persistence ----------------------------------------------------------

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        this.entries = JSON.parse(raw) as KnowledgeEntry[];
      }
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), "utf-8");
  }

  // -- public API -----------------------------------------------------------

  /** Add a new knowledge entry. Auto-generates id & timestamps if missing. */
  add(entry: Omit<KnowledgeEntry, "id" | "createdAt" | "lastAccessedAt"> & Partial<Pick<KnowledgeEntry, "id" | "createdAt" | "lastAccessedAt">>): void {
    const now = new Date().toISOString();
    const full: KnowledgeEntry = {
      id: entry.id ?? randomUUID(),
      content: entry.content,
      category: entry.category,
      source: entry.source,
      score: entry.score,
      createdAt: entry.createdAt ?? now,
      lastAccessedAt: entry.lastAccessedAt ?? now,
    };

    this.entries.push(full);

    // Cap at MAX_ENTRIES — drop oldest by createdAt
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      this.entries = this.entries.slice(0, MAX_ENTRIES);
    }

    this.save();
  }

  /** BM25+ search with temporal decay. */
  search(query: string, topN = 5): KnowledgeEntry[] {
    if (this.entries.length === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    // Pre-compute document token data
    const docData = this.entries.map((entry) => {
      const tokens = tokenize(entry.content);
      return { entry, tokens, tf: termFrequencies(tokens) };
    });

    const avgDocLength =
      docData.reduce((sum, d) => sum + d.tokens.length, 0) / docData.length;
    const N = docData.length;

    // IDF per query term
    const idf = new Map<string, number>();
    for (const qt of queryTokens) {
      const n = docData.filter((d) => d.tf.has(qt)).length;
      idf.set(qt, Math.log((N - n + 0.5) / (n + 0.5) + 1));
    }

    // Score each document
    const scored = docData.map((d) => {
      let bm25Score = 0;
      for (const qt of queryTokens) {
        const freq = d.tf.get(qt) ?? 0;
        const idfVal = idf.get(qt) ?? 0;
        const tf =
          (freq * (BM25_K1 + 1)) /
          (freq +
            BM25_K1 * (1 - BM25_B + BM25_B * (d.tokens.length / avgDocLength)));
        bm25Score += tf * idfVal;
      }
      const decay = temporalDecay(d.entry.createdAt);
      return { entry: d.entry, score: bm25Score * decay };
    });

    scored.sort((a, b) => b.score - a.score);

    // Update lastAccessedAt for returned entries
    const now = new Date().toISOString();
    const results = scored.slice(0, topN).filter((s) => s.score > 0);
    for (const r of results) {
      r.entry.lastAccessedAt = now;
      r.entry.score = r.score;
    }
    if (results.length > 0) this.save();

    return results.map((r) => r.entry);
  }

  /** Returns formatted context string suitable for prompt injection. */
  getRelevant(taskDescription: string): string {
    const results = this.search(taskDescription, 5);
    if (results.length === 0) return "";

    const lines = results.map(
      (r, i) =>
        `${i + 1}. [${r.category}] ${r.content} (source: ${r.source}, relevance: ${(r.score ?? 0).toFixed(2)})`
    );

    return `## Relevant Knowledge\n${lines.join("\n")}`;
  }

  /** Remove entries older than 90 days. Returns count removed. */
  prune(): number {
    const cutoff = Date.now() - PRUNE_AGE_DAYS * 24 * 60 * 60 * 1000;
    const before = this.entries.length;
    this.entries = this.entries.filter(
      (e) => new Date(e.createdAt).getTime() >= cutoff
    );
    const removed = before - this.entries.length;
    if (removed > 0) this.save();
    return removed;
  }

  /** Return all entries (for inspection / study). */
  getAll(): KnowledgeEntry[] {
    return [...this.entries];
  }

  /** Entry count. */
  get size(): number {
    return this.entries.length;
  }
}
