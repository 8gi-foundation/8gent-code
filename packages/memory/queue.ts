/**
 * Lease-based job queue for memory consolidation.
 *
 * Prevents multiple agents from running consolidation simultaneously.
 * Uses SQLite for coordination with automatic lease expiry.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

export interface Job {
  id: string;
  type: "consolidation" | "decay" | "checkpoint" | "embedding";
  status: "queued" | "leased" | "completed" | "failed";
  leasedBy: string | null;
  leasedAt: number | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  completedAt: number | null;
  error: string | null;
}

const LEASE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

export function createJobTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      leasedBy TEXT,
      leasedAt INTEGER,
      leaseExpiresAt INTEGER,
      createdAt INTEGER NOT NULL,
      completedAt INTEGER,
      error TEXT
    )
  `);
}

export function enqueue(db: Database, type: Job["type"]): string {
  const id = randomUUID();
  const now = Date.now();
  db.run(
    `INSERT INTO jobs (id, type, status, createdAt) VALUES (?, ?, 'queued', ?)`,
    [id, type, now],
  );
  return id;
}

export function acquireLease(db: Database, workerId: string): Job | null {
  const now = Date.now();
  const expiresAt = now + LEASE_DURATION_MS;

  // Reclaim expired leases first
  db.run(
    `UPDATE jobs SET status = 'queued', leasedBy = NULL, leasedAt = NULL, leaseExpiresAt = NULL
     WHERE status = 'leased' AND leaseExpiresAt < ?`,
    [now],
  );

  // Atomically acquire the oldest queued job
  const job = db
    .query<Job, [string, number, number, number]>(
      `UPDATE jobs SET status = 'leased', leasedBy = ?, leasedAt = ?, leaseExpiresAt = ?
       WHERE id = (SELECT id FROM jobs WHERE status = 'queued' ORDER BY createdAt ASC LIMIT 1)
       RETURNING *`,
    )
    .get(workerId, now, expiresAt, now);

  return job ?? null;
}

export function completeLease(
  db: Database,
  jobId: string,
  workerId: string,
): boolean {
  const now = Date.now();
  const result = db.run(
    `UPDATE jobs SET status = 'completed', completedAt = ? WHERE id = ? AND leasedBy = ?`,
    [now, jobId, workerId],
  );
  return result.changes > 0;
}

export function failLease(
  db: Database,
  jobId: string,
  workerId: string,
  error: string,
): boolean {
  const result = db.run(
    `UPDATE jobs SET status = 'failed', error = ? WHERE id = ? AND leasedBy = ?`,
    [error, jobId, workerId],
  );
  return result.changes > 0;
}

export function pendingCount(db: Database): number {
  const row = db
    .query<{ count: number }, []>(
      `SELECT COUNT(*) as count FROM jobs WHERE status IN ('queued', 'leased')`,
    )
    .get();
  return row?.count ?? 0;
}
