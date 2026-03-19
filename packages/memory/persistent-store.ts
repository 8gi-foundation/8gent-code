/**
 * Persistent Memory DB — SQLite-backed with FTS5 full-text search
 *
 * Hermes-inspired persistent memory so the agent retains solutions,
 * error patterns, user preferences, codebase insights, and architecture
 * decisions across sessions. Uses bun:sqlite for zero-dependency persistence.
 *
 * DB location: ~/.8gent/memory.db
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────

export type MemoryType =
  | "solution"
  | "error_pattern"
  | "user_preference"
  | "codebase_insight"
  | "architecture_decision";

export interface Memory {
  id?: string;
  type: MemoryType;
  content: string;
  context: string;
  score: number;
  createdAt?: number;
  accessedAt?: number;
  sessionId: string;
}

export interface MemoryStats {
  total: number;
  byType: Record<string, number>;
  oldestDays: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = join(homedir(), ".8gent", "memory.db");
const DECAY_THRESHOLD_DAYS = 60;
const DECAY_SCORE_THRESHOLD = 0.3;

// ── PersistentMemoryStore ──────────────────────────────────────────────────

export class PersistentMemoryStore {
  private db: Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.init();
  }

  /** Create tables and FTS5 virtual table if they don't exist. */
  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        score REAL NOT NULL DEFAULT 0.5,
        created_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL,
        session_id TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        context,
        content='memories',
        content_rowid='rowid'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, context)
        VALUES (NEW.rowid, NEW.content, NEW.context);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, context)
        VALUES ('delete', OLD.rowid, OLD.content, OLD.context);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, context)
        VALUES ('delete', OLD.rowid, OLD.content, OLD.context);
        INSERT INTO memories_fts(rowid, content, context)
        VALUES (NEW.rowid, NEW.content, NEW.context);
      END;

      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
      CREATE INDEX IF NOT EXISTS idx_memories_score ON memories(score);
    `);
  }

  /** Store a memory and return its ID. */
  store(memory: Memory): string {
    const id = memory.id ?? randomUUID();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO memories (id, type, content, context, score, created_at, accessed_at, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        memory.type,
        memory.content,
        memory.context,
        memory.score,
        memory.createdAt ?? now,
        memory.accessedAt ?? now,
        memory.sessionId,
      );

    return id;
  }

  /** Full-text search across memory content and context. */
  search(query: string, limit: number = 10): Memory[] {
    const rows = this.db
      .prepare(
        `SELECT m.*
         FROM memories m
         JOIN memories_fts fts ON m.rowid = fts.rowid
         WHERE memories_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit) as any[];

    // Update accessed_at for returned memories
    const now = Date.now();
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      this.db
        .prepare(
          `UPDATE memories SET accessed_at = ? WHERE id IN (${placeholders})`,
        )
        .run(now, ...ids);
    }

    return rows.map(rowToMemory);
  }

  /** Recall memories by type, ordered by most recent. */
  recall(type: string, limit: number = 10): Memory[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE type = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(type, limit) as any[];

    return rows.map(rowToMemory);
  }

  /** Get all memories from a specific session. */
  getSessionHistory(sessionId: string): Memory[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE session_id = ? ORDER BY created_at ASC`,
      )
      .all(sessionId) as any[];

    return rows.map(rowToMemory);
  }

  /**
   * Decay old, low-scoring memories.
   * Removes memories with score < threshold that are older than 60 days.
   * Returns the number of removed memories.
   */
  decay(): number {
    const cutoff = Date.now() - DECAY_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

    const result = this.db
      .prepare(
        `DELETE FROM memories WHERE score < ? AND created_at < ?`,
      )
      .run(DECAY_SCORE_THRESHOLD, cutoff);

    return result.changes;
  }

  /** Get aggregate statistics about the memory store. */
  stats(): MemoryStats {
    const totalRow = this.db
      .prepare("SELECT COUNT(*) as cnt FROM memories")
      .get() as any;

    const typeRows = this.db
      .prepare("SELECT type, COUNT(*) as cnt FROM memories GROUP BY type")
      .all() as any[];

    const oldestRow = this.db
      .prepare("SELECT MIN(created_at) as oldest FROM memories")
      .get() as any;

    const byType: Record<string, number> = {};
    for (const row of typeRows) {
      byType[row.type] = row.cnt;
    }

    const oldestMs = oldestRow?.oldest ?? Date.now();
    const oldestDays = Math.floor(
      (Date.now() - oldestMs) / (24 * 60 * 60 * 1000),
    );

    return {
      total: totalRow?.cnt ?? 0,
      byType,
      oldestDays: Math.max(0, oldestDays),
    };
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function rowToMemory(row: any): Memory {
  return {
    id: row.id,
    type: row.type as MemoryType,
    content: row.content,
    context: row.context,
    score: row.score,
    createdAt: row.created_at,
    accessedAt: row.accessed_at,
    sessionId: row.session_id,
  };
}
