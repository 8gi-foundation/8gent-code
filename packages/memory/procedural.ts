/**
 * Procedural Memory - captures HOW to do things.
 *
 * Unlike episodic memory (facts about what happened), procedural memory
 * stores executable knowledge: code patterns, tool sequences, and
 * workflows that worked. Confidence is updated via success/failure tracking.
 */

import { Database } from "bun:sqlite";
import { randomUUIDv7 } from "bun";

export interface ProceduralMemory {
  id: string;
  pattern: string;
  steps: string[];
  tools: string[];
  context: string;
  successCount: number;
  failCount: number;
  confidence: number;
  lastUsed: number;
  createdAt: number;
}

export function createProceduralTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS procedural_memory (
      id TEXT PRIMARY KEY,
      pattern TEXT NOT NULL,
      steps TEXT NOT NULL,
      tools TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '',
      success_count INTEGER NOT NULL DEFAULT 1,
      fail_count INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 1.0,
      last_used INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
}

export function recordProcedure(
  db: Database,
  pattern: string,
  steps: string[],
  tools: string[],
  context: string,
): string {
  const now = Date.now();
  const existing = db
    .query<{ id: string; success_count: number; fail_count: number }, [string]>(
      "SELECT id, success_count, fail_count FROM procedural_memory WHERE pattern = ?",
    )
    .get(pattern);

  if (existing) {
    const newSuccess = existing.success_count + 1;
    const confidence = newSuccess / (newSuccess + existing.fail_count);
    db.run(
      "UPDATE procedural_memory SET success_count = ?, confidence = ?, last_used = ?, steps = ?, tools = ? WHERE id = ?",
      [newSuccess, confidence, now, JSON.stringify(steps), JSON.stringify(tools), existing.id],
    );
    return existing.id;
  }

  const id = randomUUIDv7();
  db.run(
    "INSERT INTO procedural_memory (id, pattern, steps, tools, context, success_count, fail_count, confidence, last_used, created_at) VALUES (?, ?, ?, ?, ?, 1, 0, 1.0, ?, ?)",
    [id, pattern, JSON.stringify(steps), JSON.stringify(tools), context, now, now],
  );
  return id;
}

export function recordFailure(db: Database, procedureId: string): void {
  const row = db
    .query<{ success_count: number; fail_count: number }, [string]>(
      "SELECT success_count, fail_count FROM procedural_memory WHERE id = ?",
    )
    .get(procedureId);
  if (!row) return;

  const newFail = row.fail_count + 1;
  const confidence = row.success_count / (row.success_count + newFail);
  db.run(
    "UPDATE procedural_memory SET fail_count = ?, confidence = ?, last_used = ? WHERE id = ?",
    [newFail, confidence, Date.now(), procedureId],
  );
}

function rowToMemory(row: Record<string, unknown>): ProceduralMemory {
  return {
    id: row.id as string,
    pattern: row.pattern as string,
    steps: JSON.parse(row.steps as string),
    tools: JSON.parse(row.tools as string),
    context: row.context as string,
    successCount: row.success_count as number,
    failCount: row.fail_count as number,
    confidence: row.confidence as number,
    lastUsed: row.last_used as number,
    createdAt: row.created_at as number,
  };
}

export function findProcedures(
  db: Database,
  query: string,
  limit: number = 5,
): ProceduralMemory[] {
  const rows = db
    .query(
      "SELECT * FROM procedural_memory WHERE pattern LIKE ? ORDER BY confidence DESC, last_used DESC LIMIT ?",
    )
    .all(`%${query}%`, limit) as Record<string, unknown>[];
  return rows.map(rowToMemory);
}

export function getTopProcedures(
  db: Database,
  limit: number = 10,
): ProceduralMemory[] {
  const rows = db
    .query(
      "SELECT * FROM procedural_memory ORDER BY confidence DESC, last_used DESC LIMIT ?",
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToMemory);
}
