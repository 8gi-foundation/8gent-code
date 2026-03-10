/**
 * 8gent Code - Primitives Registry
 *
 * SQLite-backed registry for design primitives, components, and patterns.
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

const DB_PATH = process.env.EIGHTGENT_DB || path.join(process.env.HOME || "", ".8gent", "registry.db");
const SCHEMA_PATH = path.join(__dirname, "schema.sql");

let db: Database.Database | null = null;

/**
 * Initialize the database
 */
export function initDatabase(): Database.Database {
  if (db) return db;

  // Ensure directory exists
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Create database
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  // Run schema
  const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(schema);

  console.log(`[registry] Database initialized at ${DB_PATH}`);
  return db;
}

/**
 * Get database instance
 */
export function getDatabase(): Database.Database {
  if (!db) {
    return initDatabase();
  }
  return db;
}

// ============================================
// Primitive Operations
// ============================================

export interface Primitive {
  id: string;
  type: "component" | "animation" | "workflow" | "schema" | "pattern";
  name: string;
  description?: string;
  source: string;
  sourceType?: "file" | "inline" | "url";
  language?: string;
  tags?: string[];
  usage?: string;
  dependencies?: string[];
  metadata?: Record<string, unknown>;
}

export function addPrimitive(primitive: Primitive): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO primitives
    (id, type, name, description, source, source_type, language, tags, usage, dependencies, metadata, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  stmt.run(
    primitive.id,
    primitive.type,
    primitive.name,
    primitive.description || null,
    primitive.source,
    primitive.sourceType || "file",
    primitive.language || null,
    JSON.stringify(primitive.tags || []),
    primitive.usage || null,
    JSON.stringify(primitive.dependencies || []),
    JSON.stringify(primitive.metadata || {})
  );
}

export function getPrimitive(id: string): Primitive | null {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM primitives WHERE id = ?").get(id) as any;
  if (!row) return null;
  return rowToPrimitive(row);
}

export function searchPrimitives(query: string, options?: {
  type?: string;
  limit?: number;
}): Primitive[] {
  const db = getDatabase();
  const limit = options?.limit || 20;

  let sql: string;
  let params: any[];

  if (options?.type) {
    sql = `
      SELECT p.* FROM primitives p
      JOIN primitives_fts fts ON p.rowid = fts.rowid
      WHERE primitives_fts MATCH ? AND p.type = ?
      LIMIT ?
    `;
    params = [query, options.type, limit];
  } else {
    sql = `
      SELECT p.* FROM primitives p
      JOIN primitives_fts fts ON p.rowid = fts.rowid
      WHERE primitives_fts MATCH ?
      LIMIT ?
    `;
    params = [query, limit];
  }

  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(rowToPrimitive);
}

export function listPrimitivesByType(type: string): Primitive[] {
  const db = getDatabase();
  const rows = db.prepare("SELECT * FROM primitives WHERE type = ?").all(type) as any[];
  return rows.map(rowToPrimitive);
}

function rowToPrimitive(row: any): Primitive {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    description: row.description,
    source: row.source,
    sourceType: row.source_type,
    language: row.language,
    tags: JSON.parse(row.tags || "[]"),
    usage: row.usage,
    dependencies: JSON.parse(row.dependencies || "[]"),
    metadata: JSON.parse(row.metadata || "{}"),
  };
}

// ============================================
// Session Tracking
// ============================================

export function startSession(workingDirectory: string): string {
  const db = getDatabase();
  const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  db.prepare(`
    INSERT INTO sessions (id, working_directory)
    VALUES (?, ?)
  `).run(id, workingDirectory);

  return id;
}

export function endSession(sessionId: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE sessions SET ended_at = datetime('now') WHERE id = ?
  `).run(sessionId);
}

export function recordCommand(
  sessionId: string,
  command: string,
  result: string,
  tokensUsed: number,
  tokensSaved: number
): void {
  const db = getDatabase();

  db.prepare(`
    INSERT INTO command_history (session_id, command, result, tokens_used, tokens_saved)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, command, result, tokensUsed, tokensSaved);

  db.prepare(`
    UPDATE sessions
    SET tokens_used = tokens_used + ?,
        tokens_saved = tokens_saved + ?,
        commands_executed = commands_executed + 1
    WHERE id = ?
  `).run(tokensUsed, tokensSaved, sessionId);
}

export function getSessionStats(sessionId: string): {
  tokensUsed: number;
  tokensSaved: number;
  commandsExecuted: number;
} | null {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT tokens_used, tokens_saved, commands_executed FROM sessions WHERE id = ?
  `).get(sessionId) as any;

  if (!row) return null;
  return {
    tokensUsed: row.tokens_used,
    tokensSaved: row.tokens_saved,
    commandsExecuted: row.commands_executed,
  };
}

export function getTotalStats(): {
  totalSessions: number;
  totalTokensUsed: number;
  totalTokensSaved: number;
  totalCommands: number;
} {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT
      COUNT(*) as total_sessions,
      COALESCE(SUM(tokens_used), 0) as total_tokens_used,
      COALESCE(SUM(tokens_saved), 0) as total_tokens_saved,
      COALESCE(SUM(commands_executed), 0) as total_commands
    FROM sessions
  `).get() as any;

  return {
    totalSessions: row.total_sessions,
    totalTokensUsed: row.total_tokens_used,
    totalTokensSaved: row.total_tokens_saved,
    totalCommands: row.total_commands,
  };
}
