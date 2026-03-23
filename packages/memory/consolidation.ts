/**
 * Memory Consolidation Pipeline
 *
 * Deterministic summarization of memories over time without LLM calls.
 * Mirrors how human memory consolidates: raw -> daily -> weekly -> monthly -> archetype.
 *
 * Does NOT delete source memories - just marks them as consolidated and creates
 * higher-level summary memories that reference the originals.
 */

import { Database } from "bun:sqlite";
import { type ConsolidationLevel, type Memory, generateId } from "./types.js";

// ── Consolidation Prompt ──────────────────────────────────────────────

/** LLM prompt for consolidation — frames output as the ENTIRE surviving memory */
export const CONSOLIDATION_PROMPT = `You are the memory curator for an AI agent.
Your output will become THE ENTIRETY of the agent's memory about this user.
Any information you do not include in your output will be IMMEDIATELY AND PERMANENTLY FORGOTTEN.
Be precise. Be selective. Preserve what matters. Discard noise.
Output structured observations, not prose.`;

// ── Public Types ──────────────────────────────────────────────────────

export interface ConsolidationResult {
  level: ConsolidationLevel;
  memoriesProcessed: number;
  summariesCreated: number;
  timestamp: string;
}

interface GroupedRow {
  id: string;
  data: string;
  content_text: string;
  tags: string;
  importance: number;
  type: string;
  scope: string;
  category: string | null;
}

// ── Schema Migration ──────────────────────────────────────────────────

/**
 * Ensure the consolidation_level column exists on the memories table.
 * Safe to call multiple times - uses IF NOT EXISTS pattern via try/catch.
 */
export function ensureConsolidationSchema(db: Database): void {
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN consolidation_level TEXT NOT NULL DEFAULT 'raw'`);
  } catch {
    // Column already exists - this is expected after first run
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_consolidation ON memories(consolidation_level)`);
}

// ── Main Entry Point ──────────────────────────────────────────────────

/**
 * Consolidate raw memories into higher-level summaries.
 *
 * Daily: Group today's episodic memories by category, summarize each group
 * Weekly: Merge related daily summaries into weekly themes
 * Monthly: Generate archetype patterns from accumulated data
 */
export async function consolidate(
  db: Database,
  level: ConsolidationLevel,
  userId?: string
): Promise<ConsolidationResult> {
  ensureConsolidationSchema(db);

  switch (level) {
    case "daily":
      return consolidateDaily(db, userId);
    case "weekly":
      return consolidateWeekly(db, userId);
    case "monthly":
      return consolidateMonthly(db, userId);
    default:
      return { level, memoriesProcessed: 0, summariesCreated: 0, timestamp: new Date().toISOString() };
  }
}

// ── Daily Consolidation ───────────────────────────────────────────────

function consolidateDaily(db: Database, userId?: string): ConsolidationResult {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const rows = queryMemoriesByLevel(db, "raw", oneDayAgo, userId);

  const groups = groupByCategory(rows);
  let memoriesProcessed = 0;
  let summariesCreated = 0;

  const transaction = db.transaction(() => {
    for (const [category, members] of groups) {
      if (members.length < 3) continue;

      const summaryId = createSummaryMemory(db, members, "daily", category);
      logConsolidation(db, "daily", members.map((m) => m.id), summaryId);
      markConsolidated(db, members.map((m) => m.id), "daily");

      memoriesProcessed += members.length;
      summariesCreated++;
    }
  });

  transaction();

  return {
    level: "daily",
    memoriesProcessed,
    summariesCreated,
    timestamp: new Date().toISOString(),
  };
}

// ── Weekly Consolidation ──────────────────────────────────────────────

function consolidateWeekly(db: Database, userId?: string): ConsolidationResult {
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const rows = queryMemoriesByLevel(db, "daily", oneWeekAgo, userId);

  const groups = groupByCategory(rows);
  let memoriesProcessed = 0;
  let summariesCreated = 0;

  const transaction = db.transaction(() => {
    for (const [category, members] of groups) {
      if (members.length < 2) continue;

      const summaryId = createSummaryMemory(db, members, "weekly", category);
      logConsolidation(db, "weekly", members.map((m) => m.id), summaryId);
      markConsolidated(db, members.map((m) => m.id), "weekly");

      memoriesProcessed += members.length;
      summariesCreated++;
    }
  });

  transaction();

  return {
    level: "weekly",
    memoriesProcessed,
    summariesCreated,
    timestamp: new Date().toISOString(),
  };
}

// ── Monthly Consolidation ─────────────────────────────────────────────

function consolidateMonthly(db: Database, userId?: string): ConsolidationResult {
  const oneMonthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const rows = queryMemoriesByLevel(db, "weekly", oneMonthAgo, userId);

  const groups = groupByCategory(rows);
  let memoriesProcessed = 0;
  let summariesCreated = 0;

  const transaction = db.transaction(() => {
    for (const [category, members] of groups) {
      if (members.length < 2) continue;

      const summaryId = createSummaryMemory(db, members, "archetype", category);
      logConsolidation(db, "monthly", members.map((m) => m.id), summaryId);
      markConsolidated(db, members.map((m) => m.id), "archetype");

      memoriesProcessed += members.length;
      summariesCreated++;
    }
  });

  transaction();

  return {
    level: "monthly",
    memoriesProcessed,
    summariesCreated,
    timestamp: new Date().toISOString(),
  };
}

// ── Query Helpers ─────────────────────────────────────────────────────

function queryMemoriesByLevel(
  db: Database,
  level: ConsolidationLevel,
  since: number,
  userId?: string
): GroupedRow[] {
  let sql = `
    SELECT id, data, content_text, tags, importance, type, scope,
           json_extract(data, '$.category') as category
    FROM memories
    WHERE consolidation_level = ?
      AND created_at >= ?
      AND deleted_at IS NULL
  `;
  const params: unknown[] = [level, since];

  if (userId) {
    sql += " AND json_extract(data, '$.userId') = ?";
    params.push(userId);
  }

  sql += " ORDER BY created_at ASC";

  return db.prepare(sql).all(...params) as GroupedRow[];
}

function groupByCategory(rows: GroupedRow[]): Map<string, GroupedRow[]> {
  const groups = new Map<string, GroupedRow[]>();
  for (const row of rows) {
    const key = row.category || row.type || "uncategorized";
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  return groups;
}

// ── Summary Creation ──────────────────────────────────────────────────

function createSummaryMemory(
  db: Database,
  members: GroupedRow[],
  level: ConsolidationLevel,
  category: string
): string {
  const id = generateId("mem");
  const now = Date.now();

  // Deterministic summarization: concatenate with count prefix
  const contents = members.map((m) => m.content_text).filter(Boolean);
  const summaryText = `From ${members.length} observations: ${contents.join(" | ")}`;

  // Collect most common tags across all members
  const tagCounts = new Map<string, number>();
  for (const member of members) {
    try {
      const parsed = JSON.parse(member.tags || "[]") as string[];
      for (const tag of parsed) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    } catch {
      // Skip malformed tags
    }
  }
  const topTags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag]) => tag);

  // Importance = max importance from the group
  const maxImportance = Math.max(...members.map((m) => m.importance));

  // Use the most common type and scope from the group
  const representativeType = mostCommon(members.map((m) => m.type)) || "semantic";
  const representativeScope = mostCommon(members.map((m) => m.scope)) || "project";

  // Build a semantic memory as the summary container
  const memoryData: Record<string, unknown> = {
    id,
    type: representativeType,
    scope: representativeScope,
    category,
    key: `${level}-${category}-${now}`,
    value: summaryText,
    content: summaryText,
    title: `${level} summary: ${category}`,
    importance: maxImportance,
    decayFactor: 1.0,
    accessCount: 0,
    lastAccessed: now,
    confidence: 0.8,
    evidenceCount: members.length,
    version: 1,
    source: "consolidation",
    sourceId: null,
    tags: topTags,
    relatedKeys: [],
    learnedAt: now,
    lastConfirmed: now,
    createdAt: now,
    updatedAt: now,
  };

  const stmt = db.prepare(`
    INSERT INTO memories (
      id, type, scope, data, content_text, tags, importance, decay_factor,
      access_count, last_accessed, confidence, evidence_count, version,
      source, source_id, created_at, updated_at, consolidation_level
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    representativeType,
    representativeScope,
    JSON.stringify(memoryData),
    summaryText,
    JSON.stringify(topTags),
    maxImportance,
    1.0,
    0,
    now,
    0.8,
    members.length,
    1,
    "consolidation",
    null,
    now,
    now,
    level
  );

  return id;
}

// ── Mutation Helpers ──────────────────────────────────────────────────

function markConsolidated(db: Database, ids: string[], level: ConsolidationLevel): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`UPDATE memories SET consolidation_level = ? WHERE id IN (${placeholders})`).run(
    level,
    ...ids
  );
}

function logConsolidation(
  db: Database,
  level: string,
  sourceIds: string[],
  resultId: string
): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO consolidation_log (id, level, source_ids, result_id, status, started_at, completed_at, created_at)
    VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)
  `).run(
    generateId("mem"),
    level,
    JSON.stringify(sourceIds),
    resultId,
    now,
    now,
    now
  );
}

// ── Utilities ─────────────────────────────────────────────────────────

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [val, count] of counts) {
    if (count > bestCount) {
      best = val;
      bestCount = count;
    }
  }
  return best;
}
