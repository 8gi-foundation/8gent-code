/**
 * TaskQueue - SQLite-backed durable task queue for board plane.
 *
 * Stores tasks in WAL-mode SQLite via bun:sqlite. Supports create,
 * assign, complete, fail, stale recovery, and stats.
 */

import { Database } from "bun:sqlite";
import type { BoardTask } from "./types";

type TaskInsert = Omit<
  BoardTask,
  "id" | "status" | "response" | "vesselId" | "retryCount" | "assignedAt" | "completedAt" | "error"
>;

export class TaskQueue {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS board_tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        memberCode TEXT NOT NULL,
        channelId TEXT NOT NULL,
        messageId TEXT NOT NULL,
        authorId TEXT NOT NULL,
        authorName TEXT NOT NULL,
        content TEXT NOT NULL,
        systemPrompt TEXT NOT NULL,
        contextMessages TEXT NOT NULL DEFAULT '[]',
        response TEXT,
        vesselId TEXT,
        retryCount INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL,
        assignedAt INTEGER,
        completedAt INTEGER,
        error TEXT
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON board_tasks(status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_member ON board_tasks(memberCode)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_channel ON board_tasks(channelId)`);
  }

  createTask(task: TaskInsert): string {
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const stmt = this.db.prepare(`
      INSERT INTO board_tasks (id, status, memberCode, channelId, messageId, authorId, authorName, content, systemPrompt, contextMessages, retryCount, createdAt)
      VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `);
    stmt.run(
      id,
      task.memberCode,
      task.channelId,
      task.messageId,
      task.authorId,
      task.authorName,
      task.content,
      task.systemPrompt,
      JSON.stringify(task.contextMessages),
      task.createdAt,
    );
    return id;
  }

  assignTask(memberCode: string, vesselId: string): BoardTask | null {
    const now = Date.now();
    // Find oldest pending or retry task for this member
    const row = this.db
      .prepare(
        `SELECT * FROM board_tasks WHERE memberCode = ? AND status IN ('pending', 'retry') ORDER BY createdAt ASC LIMIT 1`,
      )
      .get(memberCode) as any;

    if (!row) return null;

    this.db
      .prepare(`UPDATE board_tasks SET status = 'assigned', vesselId = ?, assignedAt = ? WHERE id = ?`)
      .run(vesselId, now, row.id);

    return this.rowToTask({ ...row, status: "assigned", vesselId, assignedAt: now });
  }

  completeTask(taskId: string, response: string): void {
    this.db
      .prepare(`UPDATE board_tasks SET status = 'completed', response = ?, completedAt = ? WHERE id = ?`)
      .run(response, Date.now(), taskId);
  }

  failTask(taskId: string, error: string): void {
    const row = this.db.prepare(`SELECT retryCount FROM board_tasks WHERE id = ?`).get(taskId) as any;
    if (!row) return;

    const newRetry = (row.retryCount || 0) + 1;
    const newStatus = newRetry < 3 ? "retry" : "failed";

    this.db
      .prepare(`UPDATE board_tasks SET status = ?, error = ?, retryCount = ?, vesselId = NULL, assignedAt = NULL WHERE id = ?`)
      .run(newStatus, error, newRetry, taskId);
  }

  recoverStaleTasks(maxAgeMs: number = 120_000): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.db
      .prepare(`UPDATE board_tasks SET status = 'pending', vesselId = NULL, assignedAt = NULL WHERE status = 'assigned' AND assignedAt < ?`)
      .run(cutoff);
    return result.changes;
  }

  getRecentTasks(channelId: string, limit: number = 10): BoardTask[] {
    const rows = this.db
      .prepare(`SELECT * FROM board_tasks WHERE channelId = ? AND status = 'completed' ORDER BY completedAt DESC LIMIT ?`)
      .all(channelId, limit) as any[];
    return rows.map((r) => this.rowToTask(r));
  }

  getStats(): { pending: number; assigned: number; completed: number; failed: number } {
    const row = this.db
      .prepare(
        `SELECT
          SUM(CASE WHEN status IN ('pending','retry') THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'assigned' THEN 1 ELSE 0 END) as assigned,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
        FROM board_tasks`,
      )
      .get() as any;

    return {
      pending: row?.pending || 0,
      assigned: row?.assigned || 0,
      completed: row?.completed || 0,
      failed: row?.failed || 0,
    };
  }

  close(): void {
    this.db.close();
  }

  private rowToTask(row: any): BoardTask {
    return {
      id: row.id,
      status: row.status,
      memberCode: row.memberCode,
      channelId: row.channelId,
      messageId: row.messageId,
      authorId: row.authorId,
      authorName: row.authorName,
      content: row.content,
      systemPrompt: row.systemPrompt,
      contextMessages: JSON.parse(row.contextMessages || "[]"),
      response: row.response ?? null,
      vesselId: row.vesselId ?? null,
      retryCount: row.retryCount ?? 0,
      createdAt: row.createdAt,
      assignedAt: row.assignedAt ?? null,
      completedAt: row.completedAt ?? null,
      error: row.error ?? null,
    };
  }
}
