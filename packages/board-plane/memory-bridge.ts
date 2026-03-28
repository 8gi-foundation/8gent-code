/**
 * MemoryBridge - Scoped memory access for board vessel conversations.
 *
 * Stores and retrieves conversation context per channel + member pair.
 * Uses SQLite for persistence. Keeps last N interactions per scope
 * so vessels have conversational continuity across sessions.
 */

import { Database } from "bun:sqlite";

export interface MemoryEntry {
  id: string;
  scope: string;
  role: "user" | "assistant";
  content: string;
  authorId: string;
  authorName: string;
  memberCode: string;
  channelId: string;
  createdAt: number;
}

export class MemoryBridge {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS board_memory (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        authorId TEXT NOT NULL,
        authorName TEXT NOT NULL,
        memberCode TEXT NOT NULL,
        channelId TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_scope ON board_memory(scope, createdAt)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_channel ON board_memory(channelId)`);
  }

  /** Build scope key: channel + member pair */
  private scopeKey(channelId: string, memberCode: string): string {
    return `${channelId}:${memberCode}`;
  }

  /** Store a user message */
  storeUserMessage(
    channelId: string,
    memberCode: string,
    authorId: string,
    authorName: string,
    content: string,
  ): void {
    const scope = this.scopeKey(channelId, memberCode);
    const id = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare(
        `INSERT INTO board_memory (id, scope, role, content, authorId, authorName, memberCode, channelId, createdAt)
         VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, scope, content, authorId, authorName, memberCode, channelId, Date.now());
  }

  /** Store an assistant response */
  storeResponse(channelId: string, memberCode: string, content: string): void {
    const scope = this.scopeKey(channelId, memberCode);
    const id = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare(
        `INSERT INTO board_memory (id, scope, role, content, authorId, authorName, memberCode, channelId, createdAt)
         VALUES (?, ?, 'assistant', ?, '', '', ?, ?, ?)`,
      )
      .run(id, scope, content, memberCode, channelId, Date.now());
  }

  /** Get recent conversation context for a channel + member */
  getContext(
    channelId: string,
    memberCode: string,
    limit: number = 10,
  ): Array<{ role: string; content: string }> {
    const scope = this.scopeKey(channelId, memberCode);
    const rows = this.db
      .prepare(
        `SELECT role, content FROM board_memory WHERE scope = ? ORDER BY createdAt DESC LIMIT ?`,
      )
      .all(scope, limit) as Array<{ role: string; content: string }>;

    return rows.reverse();
  }

  /** Get cross-member context for a channel (hive mind view) */
  getChannelContext(
    channelId: string,
    limit: number = 20,
  ): Array<{ role: string; content: string; memberCode: string; authorName: string }> {
    const rows = this.db
      .prepare(
        `SELECT role, content, memberCode, authorName FROM board_memory
         WHERE channelId = ? ORDER BY createdAt DESC LIMIT ?`,
      )
      .all(channelId, limit) as Array<{
      role: string;
      content: string;
      memberCode: string;
      authorName: string;
    }>;

    return rows.reverse();
  }

  /** Prune old entries per scope (keep last N) */
  prune(maxPerScope: number = 50): number {
    const scopes = this.db
      .prepare(`SELECT DISTINCT scope FROM board_memory`)
      .all() as Array<{ scope: string }>;

    let pruned = 0;
    for (const { scope } of scopes) {
      const result = this.db
        .prepare(
          `DELETE FROM board_memory WHERE scope = ? AND id NOT IN (
             SELECT id FROM board_memory WHERE scope = ? ORDER BY createdAt DESC LIMIT ?
           )`,
        )
        .run(scope, scope, maxPerScope);
      pruned += result.changes;
    }
    return pruned;
  }

  /** Get stats */
  getStats(): { totalEntries: number; uniqueScopes: number } {
    const total = this.db.prepare(`SELECT COUNT(*) as c FROM board_memory`).get() as any;
    const scopes = this.db
      .prepare(`SELECT COUNT(DISTINCT scope) as c FROM board_memory`)
      .get() as any;
    return { totalEntries: total?.c ?? 0, uniqueScopes: scopes?.c ?? 0 };
  }

  close(): void {
    this.db.close();
  }
}
