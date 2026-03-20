/**
 * Memory Promotion — Frequency-based promotion and archival
 *
 * Pattern from Hermes (ArcadeAI): facts recalled 3+ times get promoted
 * to "core knowledge"; unused facts fade to archive after 30 days.
 *
 * Works directly on the SQLite store — no external deps.
 */

import { Database } from "bun:sqlite";

// ── Constants ─────────────────────────────────────────────────────────

const PROMOTE_RECALL_THRESHOLD = 3;     // recalls before promotion to core
const ARCHIVE_DAYS = 30;               // days of no access before archival
const ARCHIVE_MS = ARCHIVE_DAYS * 24 * 60 * 60 * 1000;

// ── Result Types ──────────────────────────────────────────────────────

export interface PromotionResult {
  promoted: number;    // promoted to core
  archived: number;    // moved to archive (soft-deleted)
  retained: number;    // unchanged
  durationMs: number;
}

// ── PromotionManager ──────────────────────────────────────────────────

export class PromotionManager {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this._ensureColumns();
  }

  /**
   * Run promotion pass on the database.
   *
   * - Memories with access_count >= PROMOTE_RECALL_THRESHOLD and not already
   *   core type get their importance boosted to 1.0 and decay_factor set to 0.1
   *   (very slow decay — effectively "pinned").
   *
   * - Memories with last_accessed older than ARCHIVE_MS (or never accessed and
   *   created more than ARCHIVE_MS ago) get soft-deleted.
   *
   * Returns counts for observability.
   */
  run(): PromotionResult {
    const start = Date.now();
    const now = Date.now();
    const cutoff = now - ARCHIVE_MS;

    // ── Promote: high-recall non-core memories ─────────────────────
    const promotedResult = this.db
      .prepare(
        `UPDATE memories
         SET importance   = 1.0,
             decay_factor = 0.1,
             updated_at   = ?
         WHERE deleted_at IS NULL
           AND type != 'core'
           AND access_count >= ?
           AND (importance < 1.0 OR decay_factor > 0.1)`
      )
      .run(now, PROMOTE_RECALL_THRESHOLD);

    const promoted = promotedResult.changes;

    // ── Archive: untouched memories past the cutoff ────────────────
    // A memory is stale if its last access (or creation, if never accessed)
    // is older than ARCHIVE_MS. Working memory is excluded — it has its own TTL.
    const archivedResult = this.db
      .prepare(
        `UPDATE memories
         SET deleted_at = ?,
             updated_at = ?
         WHERE deleted_at IS NULL
           AND type != 'working'
           AND (
             (last_accessed IS NOT NULL AND last_accessed < ?)
             OR
             (last_accessed IS NULL AND created_at < ?)
           )`
      )
      .run(now, now, cutoff, cutoff);

    const archived = archivedResult.changes;

    // ── Count remaining active memories ───────────────────────────
    const retained = (
      this.db
        .prepare("SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL")
        .get() as { c: number }
    ).c;

    return {
      promoted,
      archived,
      retained,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Get memories that are candidates for promotion (for preview/dry-run).
   */
  getPromotionCandidates(limit = 20): Array<{ id: string; type: string; accessCount: number; content: string }> {
    return this.db
      .prepare(
        `SELECT id, type, access_count, content_text
         FROM memories
         WHERE deleted_at IS NULL
           AND type != 'core'
           AND access_count >= ?
           AND (importance < 1.0 OR decay_factor > 0.1)
         ORDER BY access_count DESC
         LIMIT ?`
      )
      .all(PROMOTE_RECALL_THRESHOLD, limit) as Array<{ id: string; type: string; accessCount: number; content: string }>;
  }

  /**
   * Get memories that are candidates for archival (for preview/dry-run).
   */
  getArchiveCandidates(limit = 20): Array<{ id: string; type: string; lastAccessed: number | null; createdAt: number }> {
    const cutoff = Date.now() - ARCHIVE_MS;
    return this.db
      .prepare(
        `SELECT id, type, last_accessed, created_at
         FROM memories
         WHERE deleted_at IS NULL
           AND type != 'working'
           AND (
             (last_accessed IS NOT NULL AND last_accessed < ?)
             OR
             (last_accessed IS NULL AND created_at < ?)
           )
         ORDER BY COALESCE(last_accessed, created_at) ASC
         LIMIT ?`
      )
      .all(cutoff, cutoff, limit) as Array<{ id: string; type: string; lastAccessed: number | null; createdAt: number }>;
  }

  // ── Private ───────────────────────────────────────────────────────

  /** Ensure the memories table has the columns we need (safe no-op if already exist) */
  private _ensureColumns(): void {
    // bun:sqlite throws if column exists — check first
    try {
      const cols = this.db
        .prepare("PRAGMA table_info(memories)")
        .all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));

      if (!names.has("decay_factor")) {
        this.db.exec("ALTER TABLE memories ADD COLUMN decay_factor REAL NOT NULL DEFAULT 1.0");
      }
    } catch {
      // Table doesn't exist yet — schema will be created by MemoryStore
    }
  }
}

// ── Standalone helpers ────────────────────────────────────────────────

/**
 * Quick check: should a memory be considered "core knowledge"?
 * Based on access count and age — no DB required.
 */
export function isPromoted(accessCount: number, importanceScore: number): boolean {
  return accessCount >= PROMOTE_RECALL_THRESHOLD && importanceScore >= 0.9;
}

/**
 * Calculate how many days until a memory would be archived.
 * Returns 0 if it's already past the threshold.
 */
export function daysUntilArchival(lastAccessedMs: number | null, createdAtMs: number): number {
  const lastActivity = lastAccessedMs ?? createdAtMs;
  const elapsed = Date.now() - lastActivity;
  const remaining = ARCHIVE_MS - elapsed;
  return Math.max(0, Math.ceil(remaining / (24 * 60 * 60 * 1000)));
}
