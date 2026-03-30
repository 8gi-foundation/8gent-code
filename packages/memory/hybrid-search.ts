/**
 * Hybrid Search + MMR Re-ranking for Memory v2
 *
 * Combines FTS5 text scores with vector cosine similarity,
 * then applies Maximal Marginal Relevance to reduce redundancy.
 */
import { Database } from "bun:sqlite";
import { cosineSimilarity } from "./embeddings.js";
import type { Memory, SearchOptions } from "./types.js";

export interface HybridResult {
  id: string;
  content: string;
  ftsScore: number;
  vecScore: number;
  hybridScore: number;
  mmrScore?: number;
  memory: Memory;
}

export interface HybridSearchOptions {
  limit?: number;
  ftsWeight?: number;
  vecWeight?: number;
  mmrLambda?: number;
  types?: SearchOptions["types"];
  scope?: SearchOptions["scope"];
  minImportance?: number;
}

type Scored = { rawScore: number; content: string; memory: Memory };

function appendFilters(sql: string, p: (string | number)[], o?: HybridSearchOptions): string {
  if (o?.types?.length) { sql += ` AND m.type IN (${o.types.map(() => "?").join(",")})`; p.push(...o.types); }
  if (o?.scope) { sql += " AND m.scope = ?"; p.push(o.scope); }
  if (o?.minImportance) { sql += " AND m.importance >= ?"; p.push(o.minImportance); }
  return sql;
}

export function hybridSearch(db: Database, query: string, qEmb: Float32Array, opts?: HybridSearchOptions): HybridResult[] {
  const limit = opts?.limit ?? 10;
  const fW = opts?.ftsWeight ?? 0.5, vW = opts?.vecWeight ?? 0.5;
  const lambda = opts?.mmrLambda ?? 0.7;
  const fetch = limit * 3;

  // FTS5 search
  const fts = new Map<string, Scored>();
  const ftsQ = query.replace(/[^\w\s]/g, "").split(/\s+/).filter((t) => t.length > 2).map((t) => `${t}*`).join(" OR ");
  if (ftsQ) {
    const p: (string | number)[] = [ftsQ];
    let sql = appendFilters(`SELECT m.id,m.data,m.content_text,-rank as score FROM memories_fts fts JOIN memories m ON m.rowid=fts.rowid WHERE memories_fts MATCH ? AND m.deleted_at IS NULL`, p, opts);
    sql += " ORDER BY rank LIMIT ?"; p.push(fetch);
    try {
      for (const r of db.prepare(sql).all(...p) as Array<{ id: string; data: string; content_text: string; score: number }>)
        fts.set(r.id, { rawScore: r.score, content: r.content_text, memory: JSON.parse(r.data) as Memory });
    } catch { /* malformed FTS query */ }
  }

  // Vector search
  const vec = new Map<string, Scored>();
  if (qEmb.length > 0) {
    const p: (string | number)[] = [];
    const sql = appendFilters(`SELECT e.memory_id,e.vector,m.data,m.content_text FROM embeddings e JOIN memories m ON m.id=e.memory_id WHERE m.deleted_at IS NULL`, p, opts);
    const rows = db.prepare(sql).all(...p) as Array<{ memory_id: string; vector: Buffer; data: string; content_text: string }>;
    const scored: Array<{ id: string; s: number; c: string; m: Memory }> = [];
    for (const r of rows) {
      const v = new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength / 4);
      const sim = cosineSimilarity(qEmb, v);
      if (sim > 0.2) scored.push({ id: r.memory_id, s: sim, c: r.content_text, m: JSON.parse(r.data) as Memory });
    }
    scored.sort((a, b) => b.s - a.s);
    for (const s of scored.slice(0, fetch)) vec.set(s.id, { rawScore: s.s, content: s.c, memory: s.m });
  }

  // Merge + normalize
  const ids = new Set<string>([...Array.from(fts.keys()), ...Array.from(vec.keys())]);
  if (ids.size === 0) return [];
  const fMax = Math.max(...Array.from(fts.values()).map((v) => v.rawScore), 1e-9);
  const vMax = Math.max(...Array.from(vec.values()).map((v) => v.rawScore), 1e-9);

  const cands: HybridResult[] = [];
  for (const id of Array.from(ids)) {
    const f = fts.get(id), v = vec.get(id);
    const fn = f ? f.rawScore / fMax : 0, vn = v ? v.rawScore / vMax : 0;
    cands.push({ id, content: f?.content ?? v?.content ?? "", ftsScore: fn, vecScore: vn,
      hybridScore: fW * fn + vW * vn, memory: (f?.memory ?? v?.memory)! });
  }
  cands.sort((a, b) => b.hybridScore - a.hybridScore);

  // MMR re-ranking
  if (cands.length <= 1) return cands;
  const embCache = new Map<string, Float32Array>();
  if (qEmb.length > 0) {
    const cIds = cands.map((c) => c.id);
    const rows = db.prepare(`SELECT memory_id,vector FROM embeddings WHERE memory_id IN (${cIds.map(() => "?").join(",")})`)
      .all(...cIds) as Array<{ memory_id: string; vector: Buffer }>;
    for (const r of rows) embCache.set(r.memory_id, new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength / 4));
  }

  const sel: HybridResult[] = [cands[0]];
  const rem = new Set(cands.map((_, i) => i));
  rem.delete(0);
  while (sel.length < limit && rem.size > 0) {
    let bIdx = -1, bMmr = -Infinity;
    for (const i of Array.from(rem)) {
      const c = cands[i], ce = embCache.get(c.id);
      let maxSim = 0;
      if (ce?.length) for (const s of sel) { const se = embCache.get(s.id); if (se?.length) { const sim = cosineSimilarity(ce, se); if (sim > maxSim) maxSim = sim; } }
      const mmr = lambda * c.hybridScore - (1 - lambda) * maxSim;
      if (mmr > bMmr) { bMmr = mmr; bIdx = i; }
    }
    if (bIdx < 0) break;
    cands[bIdx].mmrScore = bMmr;
    sel.push(cands[bIdx]);
    rem.delete(bIdx);
  }
  sel[0].mmrScore = sel[0].hybridScore;
  return sel;
}
