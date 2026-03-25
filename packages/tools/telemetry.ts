/**
 * Privacy-first telemetry for 8gent Code.
 *
 * - Opt-in only: no data collected unless the user explicitly enables it.
 * - No PII: anonymous session stats only (commands, duration, model pref).
 * - Local-first: everything stored in SQLite under .8gent/telemetry.db.
 * - Optional upload: user triggers export; nothing phones home automatically.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---- Types ----------------------------------------------------------------

export interface TelemetryEvent {
  id: string;
  sessionId: string;
  event: string;          // e.g. "command:run", "session:end"
  payload: string;        // JSON blob - never contains PII
  createdAt: string;      // ISO 8601
}

export interface SessionSummary {
  sessionId: string;
  durationMs: number;
  commandsUsed: string[];
  modelPreference: string | null;
}

// ---- Store -----------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
`;

export class TelemetryStore {
  private db: Database;
  private enabled: boolean;
  private sessionId: string;
  private sessionStart: number;

  constructor(dataDir: string, optIn = false) {
    this.enabled = optIn;
    this.sessionId = randomUUID();
    this.sessionStart = Date.now();

    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "telemetry.db");
    this.db = new Database(dbPath);
    this.db.exec(SCHEMA);
  }

  /** Enable or disable collection at runtime. */
  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Record an event. No-op when disabled. Payload must not contain PII. */
  track(event: string, payload: Record<string, unknown> = {}): void {
    if (!this.enabled) return;
    this.db
      .prepare(
        "INSERT INTO events (id, session_id, event, payload) VALUES (?, ?, ?, ?)"
      )
      .run(randomUUID(), this.sessionId, event, JSON.stringify(payload));
  }

  /** End the current session and record a summary event. */
  endSession(modelPreference: string | null = null): SessionSummary {
    const durationMs = Date.now() - this.sessionStart;
    const rows = this.db
      .prepare("SELECT DISTINCT event FROM events WHERE session_id = ?")
      .all(this.sessionId) as { event: string }[];

    const summary: SessionSummary = {
      sessionId: this.sessionId,
      durationMs,
      commandsUsed: rows.map((r) => r.event),
      modelPreference,
    };

    this.track("session:end", summary as unknown as Record<string, unknown>);
    return summary;
  }

  /** Export all local events as a JSON string for optional manual upload. */
  export(): string {
    const rows = this.db.prepare("SELECT * FROM events ORDER BY created_at").all();
    return JSON.stringify(rows, null, 2);
  }

  /** Wipe all stored telemetry data. */
  purge(): void {
    this.db.exec("DELETE FROM events");
  }

  close(): void {
    this.db.close();
  }
}
