/**
 * AuditLog - SQLite audit trail for all board plane actions.
 *
 * Stores content hashes (SHA-256), never raw message text.
 * Tracks: who triggered, which vessel responded, duration,
 * content hash, and action type. Retained for 2 years per
 * Karen's security requirements.
 */

import { Database } from "bun:sqlite";

export type AuditAction =
  | "task:created"
  | "task:assigned"
  | "task:completed"
  | "task:failed"
  | "response:posted"
  | "response:blocked"
  | "vessel:connected"
  | "vessel:disconnected"
  | "vessel:auth_failed"
  | "memory:stored"
  | "memory:pruned";

export interface AuditEntry {
  id: string;
  action: AuditAction;
  memberCode: string;
  channelId: string;
  vesselId: string;
  taskId: string;
  authorId: string;
  contentHash: string;
  durationMs: number;
  metadata: string;
  createdAt: number;
}

export class AuditLog {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        memberCode TEXT NOT NULL DEFAULT '',
        channelId TEXT NOT NULL DEFAULT '',
        vesselId TEXT NOT NULL DEFAULT '',
        taskId TEXT NOT NULL DEFAULT '',
        authorId TEXT NOT NULL DEFAULT '',
        contentHash TEXT NOT NULL DEFAULT '',
        durationMs INTEGER NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}',
        createdAt INTEGER NOT NULL
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, createdAt)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_member ON audit_log(memberCode, createdAt)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_task ON audit_log(taskId)`);
  }

  /** Hash content with SHA-256 - never store raw text */
  private async hashContent(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** Log an audit event */
  async log(
    action: AuditAction,
    fields: {
      memberCode?: string;
      channelId?: string;
      vesselId?: string;
      taskId?: string;
      authorId?: string;
      content?: string;
      durationMs?: number;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<string> {
    const id = `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const contentHash = fields.content ? await this.hashContent(fields.content) : "";

    this.db
      .prepare(
        `INSERT INTO audit_log (id, action, memberCode, channelId, vesselId, taskId, authorId, contentHash, durationMs, metadata, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        action,
        fields.memberCode ?? "",
        fields.channelId ?? "",
        fields.vesselId ?? "",
        fields.taskId ?? "",
        fields.authorId ?? "",
        contentHash,
        fields.durationMs ?? 0,
        JSON.stringify(fields.metadata ?? {}),
        Date.now(),
      );

    return id;
  }

  /** Get recent audit entries */
  getRecent(limit: number = 50): AuditEntry[] {
    return this.db
      .prepare(`SELECT * FROM audit_log ORDER BY createdAt DESC LIMIT ?`)
      .all(limit) as AuditEntry[];
  }

  /** Get entries for a specific task */
  getByTask(taskId: string): AuditEntry[] {
    return this.db
      .prepare(`SELECT * FROM audit_log WHERE taskId = ? ORDER BY createdAt ASC`)
      .all(taskId) as AuditEntry[];
  }

  /** Get stats */
  getStats(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT action, COUNT(*) as count FROM audit_log GROUP BY action`)
      .all() as Array<{ action: string; count: number }>;
    const stats: Record<string, number> = {};
    for (const row of rows) stats[row.action] = row.count;
    return stats;
  }

  close(): void {
    this.db.close();
  }
}
